package app.panna.reader;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/** Native helpers for Panna: files from other apps, keep-screen-on, volume-key paging, home-screen widget. */
@CapacitorPlugin(name = "ReflowNative")
public class ReflowNativePlugin extends Plugin {
    private static ReflowNativePlugin instance;
    private static String pendingOpen;
    private static JSArray pending = new JSArray();
    static volatile boolean volumePaging = false;
    /** Files from other apps still being copied in. */
    static final AtomicInteger copying = new AtomicInteger();

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (ReflowNativePlugin.class) {
            result.put("files", pending);
            pending = new JSArray();
            if (pendingOpen != null) result.put("open", pendingOpen);
            pendingOpen = null;
        }
        result.put("busy", copying.get() > 0);
        call.resolve(result);
    }

    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /** Full-screen reading: hide status and navigation bars (swipe from an edge shows them briefly). */
    @PluginMethod
    public void setImmersive(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        final String color = call.getString("color", "#F2F3F7");
        getActivity().runOnUiThread(() -> {
            Window w = getActivity().getWindow();
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
            if (Build.VERSION.SDK_INT >= 28) {
                WindowManager.LayoutParams lp = w.getAttributes();
                lp.layoutInDisplayCutoutMode = on
                        ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                        : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
                w.setAttributes(lp);
            }
            try { w.getDecorView().setBackgroundColor(Color.parseColor(color)); } catch (Exception ignored) { }
            if (on) {
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                c.hide(WindowInsetsCompat.Type.systemBars());
            } else {
                c.show(WindowInsetsCompat.Type.systemBars());
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void setVolumePaging(PluginCall call) {
        volumePaging = Boolean.TRUE.equals(call.getBoolean("on", false));
        call.resolve();
    }

    /**
     * Home-screen widget data: the recent books (JSON list, newest first) and their covers
     * (book id → base64 JPEG). Covers of books no longer listed are deleted.
     */
    @PluginMethod
    public void setWidget(final PluginCall call) {
        final JSArray books = call.getArray("books");
        final JSObject covers = call.getObject("covers");
        final Context ctx = getContext();
        new Thread(() -> {
            try {
                File dir = new File(ctx.getFilesDir(), "widget");
                if (!dir.exists()) dir.mkdirs();
                if (covers != null) {
                    Iterator<String> ids = covers.keys();
                    while (ids.hasNext()) {
                        String id = ids.next();
                        try (FileOutputStream os = new FileOutputStream(PannaWidget.coverFile(ctx, id))) {
                            os.write(Base64.decode(covers.getString(id), Base64.DEFAULT));
                        }
                    }
                }
                Set<String> keep = new HashSet<>();
                for (int i = 0; books != null && i < books.length(); i++) {
                    keep.add(PannaWidget.coverFile(ctx, books.getJSONObject(i).getString("id")).getName());
                }
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) if (!keep.contains(f.getName())) f.delete();
                PannaWidget.prefs(ctx).edit().putString("books", books == null ? "[]" : books.toString()).apply();
                PannaWidget.refresh(ctx);
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not update the widget: " + e.getMessage());
            }
        }).start();
    }

    /** Ask the launcher to add the widget (Android 8+, where the launcher supports it). */
    @PluginMethod
    public void pinWidget(PluginCall call) {
        boolean ok = false;
        if (Build.VERSION.SDK_INT >= 26) {
            AppWidgetManager m = getContext().getSystemService(AppWidgetManager.class);
            if (m != null && m.isRequestPinAppWidgetSupported()) {
                ok = m.requestPinAppWidget(new ComponentName(getContext(), PannaWidget.class), null, null);
            }
        }
        JSObject result = new JSObject();
        result.put("ok", ok);
        call.resolve(result);
    }

    static void push(JSObject file) {
        synchronized (ReflowNativePlugin.class) {
            pending.put(file);
        }
        ReflowNativePlugin p = instance;
        if (p != null) p.notifyListeners("incoming", new JSObject());
    }

    /** A book picked from the widget; the page asks for it with take(). */
    static void openBook(String id) {
        synchronized (ReflowNativePlugin.class) {
            pendingOpen = id;
        }
        ReflowNativePlugin p = instance;
        if (p != null) p.notifyListeners("incoming", new JSObject());
    }

    static void receiving() {
        ReflowNativePlugin p = instance;
        if (p != null) p.notifyListeners("receiving", new JSObject());
    }

    static void volume(int dir) {
        ReflowNativePlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("dir", dir);
        p.notifyListeners("volume", o);
    }
}

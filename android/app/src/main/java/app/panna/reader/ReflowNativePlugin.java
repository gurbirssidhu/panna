package app.panna.reader;

import android.graphics.Color;
import android.os.Build;
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

/** Native helpers for Reflow: files from other apps, keep-screen-on, volume-key paging. */
@CapacitorPlugin(name = "ReflowNative")
public class ReflowNativePlugin extends Plugin {
    private static JSArray pending = new JSArray();
    private static ReflowNativePlugin instance;
    static volatile boolean volumePaging = false;

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
        }
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

    static void push(JSObject file) {
        synchronized (ReflowNativePlugin.class) {
            pending.put(file);
        }
        ReflowNativePlugin p = instance;
        if (p != null) p.notifyListeners("incoming", new JSObject());
    }

    static void volume(int dir) {
        ReflowNativePlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("dir", dir);
        p.notifyListeners("volume", o);
    }
}

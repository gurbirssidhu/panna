package app.panna.reader;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReflowNativePlugin.class);
        super.onCreate(savedInstanceState);
        if (savedInstanceState == null) handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (ReflowNativePlugin.volumePaging && (code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_VOLUME_UP)) {
            // one page per press: holding the key does not flip through the book
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                ReflowNativePlugin.volume(code == KeyEvent.KEYCODE_VOLUME_DOWN ? 1 : -1);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @SuppressWarnings("deprecation")
    private void handleIntent(Intent intent) {
        if (intent == null) return;

        // tapped the home-screen widget: open that book
        String book = intent.getStringExtra(PannaWidget.EXTRA_BOOK);
        if (book != null) {
            intent.removeExtra(PannaWidget.EXTRA_BOOK);
            ReflowNativePlugin.openBook(book);
            return;
        }

        String action = intent.getAction();
        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                    : (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                    : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;
        intent.setAction(Intent.ACTION_MAIN); // don't import the same file again on recreate

        // let the library show "receiving…" while big files are copied
        ReflowNativePlugin.copying.addAndGet(uris.size());
        ReflowNativePlugin.receiving();

        new Thread(() -> {
            File dir = new File(getCacheDir(), "incoming");
            if (!dir.exists()) dir.mkdirs();
            for (Uri uri : uris) {
                String name;
                try {
                    name = displayName(uri);
                } catch (Exception e) {
                    name = "the shared file";
                }
                try {
                    String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
                    File out = new File(dir, System.currentTimeMillis() + "_" + safe);
                    try (InputStream in = getContentResolver().openInputStream(uri);
                         OutputStream os = new FileOutputStream(out)) {
                        if (in == null) throw new FileNotFoundException("The other app did not hand over the file.");
                        byte[] buf = new byte[1 << 16];
                        int n;
                        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                    }
                    JSObject f = new JSObject();
                    f.put("name", name);
                    f.put("path", out.getAbsolutePath());
                    String type = getContentResolver().getType(uri);
                    f.put("type", type == null ? "" : type);
                    ReflowNativePlugin.copying.decrementAndGet();
                    ReflowNativePlugin.push(f);
                } catch (Exception e) {
                    JSObject f = new JSObject();
                    f.put("name", name);
                    f.put("error", (e instanceof SecurityException) || "file".equals(uri.getScheme())
                            ? "Android did not let Panna read it. Open it from the Files app, or use Share instead."
                            : "The file could not be copied. It may have been moved or deleted.");
                    ReflowNativePlugin.copying.decrementAndGet();
                    ReflowNativePlugin.push(f);
                }
            }
        }).start();
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "shared-file";
        String type = getContentResolver().getType(uri);
        String lower = name.toLowerCase();
        if (!lower.endsWith(".pdf") && !lower.endsWith(".epub") && !lower.endsWith(".djvu") && !lower.endsWith(".djv")) {
            if ("application/pdf".equals(type)) name += ".pdf";
            else if ("application/epub+zip".equals(type)) name += ".epub";
            else if (type != null && type.contains("djvu")) name += ".djvu";
        }
        return name;
    }
}

package app.panna.reader;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

/**
 * Home-screen widget: the book being read. 2x2 is the main size (the cover top-left on a blurred copy of
 * itself, a progress ring top-right, the title and a nudge along the bottom); from 4x2 up it switches to the wide card. The library lives in the web page, so the page
 * sends a summary with ReflowNative.setWidget; it is kept in SharedPreferences ("books", a JSON array, most
 * recent first) and covers in files/widget/. Tapping opens the reader on that book.
 */
public class PannaWidget extends AppWidgetProvider {
    static final String EXTRA_BOOK = "app.panna.reader.BOOK";

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) render(c, m, id);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle options) {
        render(c, m, id); // resized: below Android 12 the layout is picked here
    }

    static void refresh(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (int id : m.getAppWidgetIds(new ComponentName(c, PannaWidget.class))) render(c, m, id);
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("widget", Context.MODE_PRIVATE);
    }

    static File coverFile(Context c, String bookId) {
        return new File(new File(c.getFilesDir(), "widget"), bookId.replaceAll("[^A-Za-z0-9_-]", "_") + ".jpg");
    }

    private static JSONArray books(Context c) {
        try {
            return new JSONArray(prefs(c).getString("books", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void render(Context c, AppWidgetManager m, int id) {
        JSONArray list = books(c);
        JSONObject b = list.optJSONObject(0);
        RemoteViews views;
        if (b == null) {
            views = new RemoteViews(c.getPackageName(), R.layout.widget_empty);
            views.setOnClickPendingIntent(android.R.id.background, open(c, null));
        } else {
            Bitmap raw = loadCover(c, b.optString("id"));
            Bitmap book = raw == null ? null : bookCover(c, raw), blur = raw == null ? null : ambient(raw);
            if (Build.VERSION.SDK_INT >= 31) {
                // the launcher shows the largest layout that fits: 2x2 is about 150 dp wide, 4x2 about 310
                Map<SizeF, RemoteViews> sizes = new HashMap<>();
                sizes.put(new SizeF(50, 50), square(c, b, book, blur));
                sizes.put(new SizeF(230, 80), wide(c, b, raw));
                views = new RemoteViews(sizes);
            } else {
                int w = m.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH);
                views = w >= 230 ? wide(c, b, raw) : square(c, b, book, blur);
            }
        }
        m.updateAppWidget(id, views);
    }

    private static RemoteViews square(Context c, JSONObject b, Bitmap book, Bitmap blur) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_small);
        if (book != null) v.setImageViewBitmap(R.id.w_cover, book);
        if (blur != null) v.setImageViewBitmap(R.id.w_blur, blur);
        double pct = b.optDouble("pct", 0);
        v.setTextViewText(R.id.w_title, b.optString("title"));
        v.setImageViewBitmap(R.id.w_ring, ring(c, pct));
        String nudge = b.optString("nudge");
        v.setTextViewText(R.id.w_sub, nudge.isEmpty() ? b.optString("place") : nudge);
        v.setContentDescription(android.R.id.background, b.optString("title") + ", " + Math.round(pct * 100) + "%");
        v.setOnClickPendingIntent(android.R.id.background, open(c, b.optString("id")));
        return v;
    }

    private static RemoteViews wide(Context c, JSONObject b, Bitmap cover) {
        RemoteViews v = new RemoteViews(c.getPackageName(), R.layout.widget_wide);
        if (cover != null) v.setImageViewBitmap(R.id.w_cover, cover);
        v.setTextViewText(R.id.w_title, b.optString("title"));
        String author = b.optString("author"), place = b.optString("place");
        v.setTextViewText(R.id.w_sub, author.isEmpty() ? place : place.isEmpty() ? author : author + " · " + place);
        double pct = b.optDouble("pct", 0);
        v.setProgressBar(R.id.w_bar, 1000, permille(pct), false);
        v.setTextViewText(R.id.w_pct, Math.round(pct * 100) + "%");
        v.setOnClickPendingIntent(android.R.id.background, open(c, b.optString("id")));
        return v;
    }

    private static int permille(double pct) {
        return (int) Math.round(Math.max(0, Math.min(1, pct)) * 1000);
    }

    private static Bitmap loadCover(Context c, String bookId) {
        File f = coverFile(c, bookId);
        return f.exists() ? BitmapFactory.decodeFile(f.getAbsolutePath()) : null;
    }

    static final int SHADOW = 6; // dp of transparent margin around the cover for its shadow (widget_small.xml offsets it)

    /**
     * The cover as a book: corners rounded like the library's (small at the spine, larger at the fore-edge),
     * a darker band along the spine, and a soft drop shadow.
     */
    private static Bitmap bookCover(Context c, Bitmap src) {
        float d = c.getResources().getDisplayMetrics().density;
        int h = Math.min(Math.round(110 * d), src.getHeight() * 2), w = Math.round((float) h * src.getWidth() / src.getHeight());
        int pad = Math.round(SHADOW * d);
        Bitmap out = Bitmap.createBitmap(w + 2 * pad, h + 2 * pad, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        RectF r = new RectF(pad, pad, pad + w, pad + h);
        float spine = 1.5f * d, edge = 4.5f * d;
        Path shape = new Path();
        shape.addRoundRect(r, new float[]{spine, spine, edge, edge, edge, edge, spine, spine}, Path.Direction.CW);

        Paint shadow = new Paint(Paint.ANTI_ALIAS_FLAG);
        shadow.setColor(0xFF000000);
        shadow.setShadowLayer(4.5f * d, 0, 2.5f * d, 0x8C000000);
        cv.drawPath(shape, shadow);

        // the cover through a shader, so the rounded corners are anti-aliased (clipPath is not)
        BitmapShader shader = new BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        Matrix mx = new Matrix();
        mx.setRectToRect(new RectF(0, 0, src.getWidth(), src.getHeight()), r, Matrix.ScaleToFit.FILL);
        shader.setLocalMatrix(mx);
        Paint face = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        face.setShader(shader);
        cv.drawPath(shape, face);

        Paint band = new Paint(Paint.ANTI_ALIAS_FLAG);
        float bw = Math.max(3 * d, w * 0.075f);
        band.setShader(new LinearGradient(r.left, 0, r.left + bw, 0, new int[]{0x47000000, 0x1AFFFFFF, 0x00000000}, new float[]{0f, 0.55f, 1f}, Shader.TileMode.CLAMP));
        cv.save();
        cv.clipRect(r.left, r.top, r.left + bw, r.bottom);
        cv.drawPath(shape, band);
        cv.restore();
        return out;
    }

    /** Progress as a ring: a faint full circle and a white arc from 12 o'clock, with round ends. */
    private static Bitmap ring(Context c, double pct) {
        float d = c.getResources().getDisplayMetrics().density, size = 38 * d, stroke = 3 * d;
        Bitmap out = Bitmap.createBitmap(Math.round(size), Math.round(size), Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        RectF r = new RectF(stroke / 2 + d, stroke / 2 + d, size - stroke / 2 - d, size - stroke / 2 - d);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(stroke);
        p.setColor(0x4DFFFFFF);
        cv.drawOval(r, p);
        if (pct > 0) {
            p.setColor(0xFFFFFFFF);
            p.setStrokeCap(Paint.Cap.ROUND);
            cv.drawArc(r, -90, Math.max(8f, (float) (360 * Math.min(1, pct))), false, p); // a sliver even at 1%
        }
        return out;
    }

    /** The background: the cover shrunk to 24 px, colours boosted, box-blurred; the launcher stretches it smoothly. */
    private static Bitmap ambient(Bitmap src) {
        int w = 24, h = Math.max(2, Math.round(24f * src.getHeight() / src.getWidth()));
        Bitmap small = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        ColorMatrix cm = new ColorMatrix();
        cm.setSaturation(1.4f);
        Paint p = new Paint(Paint.FILTER_BITMAP_FLAG);
        p.setColorFilter(new ColorMatrixColorFilter(cm));
        new Canvas(small).drawBitmap(src, null, new Rect(0, 0, w, h), p);
        int[] px = new int[w * h];
        small.getPixels(px, 0, w, 0, 0, w, h);
        for (int pass = 0; pass < 2; pass++) { boxBlur(px, w, h, 3, true); boxBlur(px, w, h, 3, false); }
        small.setPixels(px, 0, w, 0, 0, w, h);
        return small;
    }

    private static void boxBlur(int[] px, int w, int h, int r, boolean horizontal) {
        int n = horizontal ? w : h, lines = horizontal ? h : w;
        int[] out = new int[n];
        for (int line = 0; line < lines; line++) {
            for (int i = 0; i < n; i++) {
                int rr = 0, gg = 0, bb = 0, k = 0;
                for (int j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++, k++) {
                    int c = px[horizontal ? line * w + j : j * w + line];
                    rr += (c >> 16) & 255; gg += (c >> 8) & 255; bb += c & 255;
                }
                out[i] = 0xFF000000 | ((rr / k) << 16) | ((gg / k) << 8) | (bb / k);
            }
            for (int i = 0; i < n; i++) px[horizontal ? line * w + i : i * w + line] = out[i];
        }
    }

    /** Opens the app; with a book id, MainActivity hands it to the page, which opens that book. */
    private static PendingIntent open(Context c, String bookId) {
        Intent i = new Intent(c, MainActivity.class).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (bookId != null) i.putExtra(EXTRA_BOOK, bookId);
        return PendingIntent.getActivity(c, 100, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}

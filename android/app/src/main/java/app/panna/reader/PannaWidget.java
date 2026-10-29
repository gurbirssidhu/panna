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
import android.graphics.Color;
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
 * "Continue reading" home-screen widget. The page sends the recent books and their covers
 * through ReflowNativePlugin.setWidget; this draws the newest one. Small sizes show the cover
 * with a progress ring, wide sizes add the author, place and a progress bar.
 */
public class PannaWidget extends AppWidgetProvider {
    static final String EXTRA_BOOK = "app.panna.reader.BOOK";
    /** Room around the cover for its drop shadow, in dp. */
    static final int SHADOW = 6;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) render(context, manager, id);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        render(context, manager, id);
    }

    static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        for (int id : manager.getAppWidgetIds(new ComponentName(context, PannaWidget.class))) {
            render(context, manager, id);
        }
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("widget", Context.MODE_PRIVATE);
    }

    static File coverFile(Context context, String id) {
        return new File(new File(context.getFilesDir(), "widget"), id.replaceAll("[^A-Za-z0-9_-]", "_") + ".jpg");
    }

    private static JSONArray books(Context context) {
        try {
            return new JSONArray(prefs(context).getString("books", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void render(Context context, AppWidgetManager manager, int id) {
        RemoteViews views;
        JSONObject book = books(context).optJSONObject(0);
        if (book == null) {
            views = new RemoteViews(context.getPackageName(), R.layout.widget_empty);
            views.setOnClickPendingIntent(android.R.id.background, open(context, null));
        } else {
            Bitmap cover = loadCover(context, book.optString("id"));
            Bitmap framed = cover == null ? null : bookCover(context, cover);
            Bitmap glow = cover == null ? null : ambient(cover);
            if (Build.VERSION.SDK_INT >= 31) {
                // responsive layouts: the launcher picks the one that fits the widget's size
                Map<SizeF, RemoteViews> sizes = new HashMap<>();
                sizes.put(new SizeF(50f, 50f), square(context, book, framed, glow));
                sizes.put(new SizeF(230f, 80f), wide(context, book, cover));
                views = new RemoteViews(sizes);
            } else {
                views = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH) >= 230
                        ? wide(context, book, cover)
                        : square(context, book, framed, glow);
            }
        }
        manager.updateAppWidget(id, views);
    }

    private static RemoteViews square(Context context, JSONObject book, Bitmap cover, Bitmap glow) {
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_small);
        if (cover != null) v.setImageViewBitmap(R.id.w_cover, cover);
        if (glow != null) v.setImageViewBitmap(R.id.w_blur, glow);
        double pct = book.optDouble("pct", 0);
        v.setTextViewText(R.id.w_title, book.optString("title"));
        v.setImageViewBitmap(R.id.w_ring, ring(context, pct));
        String sub = book.optString("nudge");
        v.setTextViewText(R.id.w_sub, sub.isEmpty() ? book.optString("place") : sub);
        v.setContentDescription(android.R.id.background, book.optString("title") + ", " + Math.round(pct * 100) + "%");
        v.setOnClickPendingIntent(android.R.id.background, open(context, book.optString("id")));
        return v;
    }

    private static RemoteViews wide(Context context, JSONObject book, Bitmap cover) {
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_wide);
        if (cover != null) v.setImageViewBitmap(R.id.w_cover, cover);
        v.setTextViewText(R.id.w_title, book.optString("title"));
        String author = book.optString("author");
        String place = book.optString("place");
        String sub = author.isEmpty() ? place : place.isEmpty() ? author : author + " · " + place;
        v.setTextViewText(R.id.w_sub, sub);
        double pct = book.optDouble("pct", 0);
        v.setProgressBar(R.id.w_bar, 1000, permille(pct), false);
        v.setTextViewText(R.id.w_pct, Math.round(pct * 100) + "%");
        v.setOnClickPendingIntent(android.R.id.background, open(context, book.optString("id")));
        return v;
    }

    private static int permille(double pct) {
        return (int) Math.round(Math.max(0, Math.min(1, pct)) * 1000);
    }

    private static Bitmap loadCover(Context context, String id) {
        File f = coverFile(context, id);
        return f.exists() ? BitmapFactory.decodeFile(f.getAbsolutePath()) : null;
    }

    /** The cover as a small physical book: rounded spine-side corners, drop shadow, spine shading. */
    private static Bitmap bookCover(Context context, Bitmap src) {
        float d = context.getResources().getDisplayMetrics().density;
        int h = Math.min(Math.round(110 * d), src.getHeight() * 2);
        int w = h * src.getWidth() / src.getHeight();
        int pad = Math.round(SHADOW * d);
        Bitmap out = Bitmap.createBitmap(w + pad * 2, h + pad * 2, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        RectF r = new RectF(pad, pad, pad + w, pad + h);
        float spine = 1.5f * d, edge = 4.5f * d;
        Path shape = new Path();
        shape.addRoundRect(r, new float[]{spine, spine, edge, edge, edge, edge, spine, spine}, Path.Direction.CW);

        Paint shadow = new Paint(Paint.ANTI_ALIAS_FLAG);
        shadow.setColor(Color.BLACK);
        shadow.setShadowLayer(edge, 0, 2.5f * d, 0x8C000000);
        canvas.drawPath(shape, shadow);

        BitmapShader shader = new BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        Matrix m = new Matrix();
        m.setRectToRect(new RectF(0, 0, src.getWidth(), src.getHeight()), r, Matrix.ScaleToFit.FILL);
        shader.setLocalMatrix(m);
        Paint image = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        image.setShader(shader);
        canvas.drawPath(shape, image);

        Paint fold = new Paint(Paint.ANTI_ALIAS_FLAG);
        float fw = Math.max(3 * d, w * 0.075f);
        fold.setShader(new LinearGradient(r.left, 0, r.left + fw, 0,
                new int[]{0x47000000, 0x1AFFFFFF, 0x00000000}, new float[]{0f, 0.55f, 1f}, Shader.TileMode.CLAMP));
        canvas.save();
        canvas.clipRect(r.left, r.top, r.left + fw, r.bottom);
        canvas.drawPath(shape, fold);
        canvas.restore();
        return out;
    }

    /** Reading progress as a ring, white on the blurred cover. */
    private static Bitmap ring(Context context, double pct) {
        float d = context.getResources().getDisplayMetrics().density;
        float size = 38 * d, stroke = 3 * d;
        Bitmap out = Bitmap.createBitmap(Math.round(size), Math.round(size), Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        float lo = stroke / 2 + d, hi = size - stroke / 2 - d;
        RectF r = new RectF(lo, lo, hi, hi);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(stroke);
        p.setColor(0x4DFFFFFF);
        canvas.drawOval(r, p);
        if (pct > 0) {
            p.setColor(Color.WHITE);
            p.setStrokeCap(Paint.Cap.ROUND);
            canvas.drawArc(r, -90, Math.max(8f, (float) (Math.min(1, pct) * 360)), false, p);
        }
        return out;
    }

    /** A tiny, saturated, blurred copy of the cover for the background of the small widget. */
    private static Bitmap ambient(Bitmap src) {
        final int w = 24;
        int h = Math.max(2, Math.round(src.getHeight() * (float) w / src.getWidth()));
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        ColorMatrix cm = new ColorMatrix();
        cm.setSaturation(1.4f);
        Paint p = new Paint(Paint.FILTER_BITMAP_FLAG);
        p.setColorFilter(new ColorMatrixColorFilter(cm));
        new Canvas(out).drawBitmap(src, null, new Rect(0, 0, w, h), p);
        int[] px = new int[w * h];
        out.getPixels(px, 0, w, 0, 0, w, h);
        for (int pass = 0; pass < 2; pass++) {
            boxBlur(px, w, h, 3, true);
            boxBlur(px, w, h, 3, false);
        }
        out.setPixels(px, 0, w, 0, 0, w, h);
        return out;
    }

    private static void boxBlur(int[] px, int w, int h, int radius, boolean horizontal) {
        int len = horizontal ? w : h;
        int lines = horizontal ? h : w;
        int[] line = new int[len];
        for (int l = 0; l < lines; l++) {
            for (int i = 0; i < len; i++) {
                int r = 0, g = 0, b = 0, n = 0;
                for (int k = Math.max(0, i - radius); k <= Math.min(len - 1, i + radius); k++) {
                    int c = px[horizontal ? l * w + k : k * w + l];
                    r += (c >> 16) & 0xFF;
                    g += (c >> 8) & 0xFF;
                    b += c & 0xFF;
                    n++;
                }
                line[i] = 0xFF000000 | ((r / n) << 16) | ((g / n) << 8) | (b / n);
            }
            for (int i = 0; i < len; i++) px[horizontal ? l * w + i : i * w + l] = line[i];
        }
    }

    private static PendingIntent open(Context context, String bookId) {
        Intent i = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (bookId != null) i.putExtra(EXTRA_BOOK, bookId);
        return PendingIntent.getActivity(context, 100, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}

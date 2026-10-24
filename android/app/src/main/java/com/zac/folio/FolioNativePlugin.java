package com.zac.folio;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Folio's native side on Android: the phone version of electron/main.cjs.
 *
 * Files are read and written in place with plain paths (/storage/emulated/0/...), exactly like the
 * desktop app, so a folder synced with the PC (Syncthing, FolderSync...) stays the single source of
 * truth. On Android 11+ that needs "All files access" (MANAGE_EXTERNAL_STORAGE).
 *
 * Plugin methods run on Capacitor's background thread; anything touching views goes to the UI thread.
 */
@CapacitorPlugin(
    name = "FolioNative",
    permissions = {
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class FolioNativePlugin extends Plugin {

    private static final long MAX_READ_BYTES = 50L * 1024 * 1024; // same limit as the desktop app
    private static final int MAX_DEPTH = 10;
    private static final int MAX_FILES = 8000;
    private static final Set<String> MD_EXT = new HashSet<>(Arrays.asList(".md", ".markdown", ".mdown", ".mkd", ".mdx"));
    private static final Set<String> IGNORE_DIRS = new HashSet<>(
        Arrays.asList("node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv", ".next", "dist", "build", ".cache")
    );

    private String lastIntentUri = null;
    private String barColor = null;
    private boolean barDark = false;

    // ------------------------------------------------------------------ lifecycle

    @Override
    public void load() {
        getActivity().runOnUiThread(this::setupWindow);
    }

    /** Edge-to-edge window; the content is padded by the system bars and the keyboard. */
    private void setupWindow() {
        Window window = getActivity().getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        if (Build.VERSION.SDK_INT < 35) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }
        View decor = window.getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(decor);
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        // Capacitor's SystemBars resets the bar colours on every configuration change: put ours back after it.
        if (barColor != null) {
            View decor = getActivity().getWindow().getDecorView();
            decor.post(() -> applyBars(barColor, barDark));
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_EDIT.equals(action)) return;
        Uri uri = intent.getData();
        if (uri == null) return;
        String s = uri.toString();
        if (s.equals(lastIntentUri)) return;
        lastIntentUri = s;
        JSObject data = new JSObject();
        data.put("uri", s);
        notifyListeners("openUri", data, true);
    }

    // ------------------------------------------------------------------ app info, access, settings

    private boolean hasAccess() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject r = new JSObject();
        r.put("hasAccess", hasAccess());
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("storage", Environment.getExternalStorageDirectory().getAbsolutePath());
        r.put("documents", Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS).getAbsolutePath());
        String version = "";
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            version = info.versionName;
        } catch (Exception ignored) {}
        r.put("version", version);
        call.resolve(r);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (hasAccess()) {
            resolveAccess(call);
            return;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, i, "accessResult");
            } catch (Exception e) {
                try {
                    startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "accessResult");
                } catch (Exception e2) {
                    call.reject("Couldn't open the storage settings.");
                }
            }
        } else {
            requestPermissionForAlias("storage", call, "storagePermResult");
        }
    }

    @ActivityCallback
    private void accessResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        resolveAccess(call);
    }

    @PermissionCallback
    private void storagePermResult(PluginCall call) {
        resolveAccess(call);
    }

    private void resolveAccess(PluginCall call) {
        JSObject r = new JSObject();
        r.put("hasAccess", hasAccess());
        call.resolve(r);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences("folio", Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void getSettings(PluginCall call) {
        JSObject r = new JSObject();
        r.put("json", prefs().getString("settings", "{}"));
        call.resolve(r);
    }

    @PluginMethod
    public void setSettings(PluginCall call) {
        String json = call.getString("json", "{}");
        prefs().edit().putString("settings", json).commit();
        call.resolve();
    }

    // ------------------------------------------------------------------ system bars

    @PluginMethod
    public void setBars(PluginCall call) {
        String color = call.getString("color", "#FFFFFF");
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        barColor = color;
        barDark = dark;
        getActivity().runOnUiThread(() -> {
            applyBars(color, dark);
            call.resolve();
        });
    }

    private void applyBars(String color, boolean dark) {
        try {
            int c = Color.parseColor(color);
            Window window = getActivity().getWindow();
            window.getDecorView().setBackgroundColor(c);
            WindowInsetsControllerCompat ctl = WindowCompat.getInsetsController(window, window.getDecorView());
            ctl.setAppearanceLightStatusBars(!dark);
            ctl.setAppearanceLightNavigationBars(!dark);
            WebView wv = getBridge().getWebView();
            if (wv != null) wv.setBackgroundColor(c);
        } catch (Exception ignored) {}
    }

    // ------------------------------------------------------------------ pickers

    @PluginMethod
    public void pickFolder(PluginCall call) {
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(call, i, "pickFolderResult");
        } catch (Exception e) {
            call.reject("Couldn't open the folder picker.");
        }
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        Uri uri = resultUri(result);
        if (uri == null) {
            call.resolve(r); // cancelled
            return;
        }
        String path = treeUriToPath(uri);
        if (path != null) r.put("path", path);
        else r.put("error", "unsupported");
        call.resolve(r);
    }

    /** kind: "markdown" (default) or "image". */
    @PluginMethod
    public void pickFile(PluginCall call) {
        String kind = call.getString("kind", "markdown");
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if ("image".equals(kind)) {
                i.setType("image/*");
            } else {
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "text/markdown", "text/x-markdown", "text/plain", "application/octet-stream" });
            }
            startActivityForResult(call, i, "pickFileResult");
        } catch (Exception e) {
            call.reject("Couldn't open the file picker.");
        }
    }

    @ActivityCallback
    private void pickFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject r = new JSObject();
        Uri uri = resultUri(result);
        if (uri == null) {
            call.resolve(r); // cancelled
            return;
        }
        if ("image".equals(call.getString("kind", "markdown"))) {
            r.put("uri", uri.toString());
            r.put("name", displayName(uri));
            call.resolve(r);
            return;
        }
        try {
            resolveToPath(uri, r);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    /** Turns a content:// or file:// URI (from "Open with" or a picker) into a path Folio can edit. */
    @PluginMethod
    public void resolveUri(PluginCall call) {
        String s = call.getString("uri");
        if (s == null) {
            call.reject("No file.");
            return;
        }
        try {
            JSObject r = new JSObject();
            resolveToPath(Uri.parse(s), r);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    private void resolveToPath(Uri uri, JSObject r) throws IOException {
        String path = documentUriToPath(uri);
        if (path != null) {
            File f = new File(path);
            if (f.isFile() && f.canRead()) {
                r.put("path", f.getPath());
                return;
            }
        }
        // A file Folio can't reach in place (an attachment, a cloud file...): keep a copy in Documents/Folio/Imported
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "Folio/Imported");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Couldn't create Documents/Folio/Imported.");
        String name = safeName(displayName(uri));
        if (name.isEmpty()) name = "Imported.md";
        String base = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            base = name.substring(0, dot);
            ext = name.substring(dot);
        }
        if (ext.isEmpty()) ext = ".md";
        File target = uniqueFile(dir, base, ext);
        copyFromUri(uri, target);
        r.put("path", target.getPath());
        r.put("imported", true);
    }

    private static Uri resultUri(ActivityResult result) {
        if (result == null || result.getResultCode() != Activity.RESULT_OK) return null;
        Intent data = result.getData();
        return data == null ? null : data.getData();
    }

    private static String volumePath(String docId) {
        int i = docId.indexOf(':');
        if (i < 0) return null;
        String vol = docId.substring(0, i);
        String rel = docId.substring(i + 1);
        String base = "primary".equalsIgnoreCase(vol) ? Environment.getExternalStorageDirectory().getAbsolutePath() : "/storage/" + vol;
        while (rel.startsWith("/")) rel = rel.substring(1);
        return rel.isEmpty() ? base : base + "/" + rel;
    }

    private static String treeUriToPath(Uri uri) {
        try {
            String auth = uri.getAuthority();
            String id = DocumentsContract.getTreeDocumentId(uri);
            if ("com.android.externalstorage.documents".equals(auth)) return volumePath(id);
            if ("com.android.providers.downloads.documents".equals(auth)) {
                if (id.startsWith("raw:")) return id.substring(4);
                if ("downloads".equals(id)) return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).getAbsolutePath();
            }
        } catch (Exception ignored) {}
        return null;
    }

    private String documentUriToPath(Uri uri) {
        try {
            if ("file".equals(uri.getScheme())) return uri.getPath();
            if (!"content".equals(uri.getScheme())) return null;
            String auth = uri.getAuthority();
            if (DocumentsContract.isDocumentUri(getContext(), uri)) {
                String id = DocumentsContract.getDocumentId(uri);
                if ("com.android.externalstorage.documents".equals(auth)) return volumePath(id);
                if ("com.android.providers.downloads.documents".equals(auth)) {
                    if (id.startsWith("raw:")) return id.substring(4);
                    if (id.startsWith("msf:")) {
                        return queryData(MediaStore.Files.getContentUri("external"), "_id=?", new String[] { id.substring(4) });
                    }
                    try {
                        Uri u = ContentUris.withAppendedId(Uri.parse("content://downloads/public_downloads"), Long.parseLong(id));
                        String p = queryData(u, null, null);
                        if (p != null) return p;
                    } catch (Exception ignored) {}
                }
                if ("com.android.providers.media.documents".equals(auth)) {
                    String[] parts = id.split(":");
                    if (parts.length == 2) {
                        return queryData(MediaStore.Files.getContentUri("external"), "_id=?", new String[] { parts[1] });
                    }
                }
            }
            return queryData(uri, null, null);
        } catch (Exception e) {
            return null;
        }
    }

    private String queryData(Uri uri, String selection, String[] args) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { "_data" }, selection, args, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex("_data");
                if (i >= 0) return c.getString(i);
            }
        } catch (Exception ignored) {}
        return null;
    }

    private String displayName(Uri uri) {
        if ("file".equals(uri.getScheme())) return new File(uri.getPath()).getName();
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) {
                    String n = c.getString(i);
                    if (n != null) return n;
                }
            }
        } catch (Exception ignored) {}
        String last = uri.getLastPathSegment();
        if (last == null) return "";
        int slash = last.lastIndexOf('/');
        return slash >= 0 ? last.substring(slash + 1) : last;
    }

    // ------------------------------------------------------------------ folder tree

    private static final class Built {
        final JSArray children;
        final boolean hasMd;
        final boolean hasOther;

        Built(JSArray children, boolean hasMd, boolean hasOther) {
            this.children = children;
            this.hasMd = hasMd;
            this.hasOther = hasOther;
        }
    }

    private static boolean isMd(String name) {
        int i = name.lastIndexOf('.');
        return i > 0 && MD_EXT.contains(name.substring(i).toLowerCase(Locale.ROOT));
    }

    /** Same rules as buildTree() in electron/main.cjs. */
    private Built build(File dir, String dirPath, int depth, int[] counter) {
        if (depth > MAX_DEPTH || counter[0] > MAX_FILES) return new Built(new JSArray(), false, false);
        File[] entries = dir.listFiles();
        if (entries == null) return new Built(new JSArray(), false, false);
        List<JSObject> folders = new ArrayList<>();
        List<JSObject> files = new ArrayList<>();
        boolean hasOther = false;
        boolean anyMd = false;
        for (File e : entries) {
            String name = e.getName();
            if (name.startsWith(".")) continue;
            String full = dirPath + "/" + name;
            if (e.isDirectory()) {
                if (IGNORE_DIRS.contains(name)) continue;
                Built sub = build(e, full, depth + 1, counter);
                if (sub.hasMd || !sub.hasOther) {
                    JSObject o = new JSObject();
                    o.put("type", "dir");
                    o.put("name", name);
                    o.put("path", full);
                    o.put("children", sub.children);
                    folders.add(o);
                }
                if (sub.hasMd) anyMd = true;
                if (sub.hasOther) hasOther = true;
            } else if (e.isFile()) {
                if (isMd(name)) {
                    JSObject o = new JSObject();
                    o.put("type", "file");
                    o.put("name", name);
                    o.put("path", full);
                    files.add(o);
                    counter[0]++;
                } else {
                    hasOther = true;
                }
            }
        }
        Comparator<JSObject> byName = (a, b) -> naturalCompare(a.getString("name"), b.getString("name"));
        folders.sort(byName);
        files.sort(byName);
        JSArray out = new JSArray();
        for (JSObject o : folders) out.put(o);
        for (JSObject o : files) out.put(o);
        return new Built(out, !files.isEmpty() || anyMd, hasOther);
    }

    private static int naturalCompare(String a, String b) {
        if (a == null) a = "";
        if (b == null) b = "";
        int i = 0;
        int j = 0;
        while (i < a.length() && j < b.length()) {
            char ca = a.charAt(i);
            char cb = b.charAt(j);
            if (Character.isDigit(ca) && Character.isDigit(cb)) {
                int si = i;
                int sj = j;
                while (i < a.length() && Character.isDigit(a.charAt(i))) i++;
                while (j < b.length() && Character.isDigit(b.charAt(j))) j++;
                String na = a.substring(si, i).replaceFirst("^0+(?=.)", "");
                String nb = b.substring(sj, j).replaceFirst("^0+(?=.)", "");
                if (na.length() != nb.length()) return na.length() - nb.length();
                int c = na.compareTo(nb);
                if (c != 0) return c;
            } else {
                int c = Character.compare(Character.toLowerCase(ca), Character.toLowerCase(cb));
                if (c != 0) return c;
                i++;
                j++;
            }
        }
        return (a.length() - i) - (b.length() - j);
    }

    @PluginMethod
    public void tree(PluginCall call) {
        String root = trimSlash(call.getString("path"));
        JSObject r = new JSObject();
        if (root == null || !new File(root).isDirectory()) {
            call.resolve(r); // no "tree" -> the folder is gone
            return;
        }
        File f = new File(root);
        Built b = build(f, root, 0, new int[] { 0 });
        JSObject t = new JSObject();
        t.put("type", "dir");
        t.put("name", f.getName());
        t.put("path", root);
        t.put("children", b.children);
        r.put("tree", t);
        call.resolve(r);
    }

    /** Cheap fingerprint of a folder's structure (names of folders and markdown files) for change polling. */
    @PluginMethod
    public void signature(PluginCall call) {
        String root = trimSlash(call.getString("path"));
        if (root == null || !new File(root).isDirectory()) {
            JSObject r = new JSObject();
            r.put("sig", "missing");
            call.resolve(r);
            return;
        }
        long[] acc = { 1125899906842597L, 0 };
        sig(new File(root), root, 0, acc);
        JSObject r = new JSObject();
        r.put("sig", Long.toHexString(acc[0]) + ":" + acc[1]);
        call.resolve(r);
    }

    private void sig(File dir, String dirPath, int depth, long[] acc) {
        if (depth > MAX_DEPTH || acc[1] > MAX_FILES * 2L) return;
        String[] names = dir.list();
        if (names == null) return;
        Arrays.sort(names);
        for (String name : names) {
            if (name.startsWith(".")) continue;
            String full = dirPath + "/" + name;
            if (isMd(name)) {
                acc[0] = 31 * acc[0] + full.hashCode();
                acc[1]++;
                continue;
            }
            if (IGNORE_DIRS.contains(name)) continue;
            File e = new File(dir, name);
            if (e.isDirectory()) {
                acc[0] = 31 * acc[0] + full.hashCode() * 7L;
                acc[1]++;
                sig(e, full, depth + 1, acc);
            }
        }
    }

    // ------------------------------------------------------------------ files

    @PluginMethod
    public void read(PluginCall call) {
        try {
            File f = new File(require(call, "path"));
            if (!f.isFile()) throw new IOException("Not a file.");
            if (f.length() > MAX_READ_BYTES) throw new IOException("This file is too large to open (over 50 MB).");
            String text = new String(readAll(new FileInputStream(f)), StandardCharsets.UTF_8);
            if (!text.isEmpty() && text.charAt(0) == '﻿') text = text.substring(1);
            JSObject r = new JSObject();
            r.put("content", text);
            r.put("mtime", f.lastModified());
            r.put("eol", text.contains("\r\n") ? "\r\n" : "\n");
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            File f = new File(require(call, "path"));
            String content = call.getString("content", "");
            writeBytes(f, content.getBytes(StandardCharsets.UTF_8));
            JSObject r = new JSObject();
            r.put("mtime", f.lastModified());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void writeBase64(PluginCall call) {
        try {
            File f = new File(require(call, "path"));
            writeBytes(f, Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            JSObject r = new JSObject();
            r.put("mtime", f.lastModified());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void copyUri(PluginCall call) {
        try {
            String src = require(call, "uri");
            File target = new File(require(call, "path"));
            copyFromUri(Uri.parse(src), target);
            call.resolve();
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        String p = call.getString("path");
        JSObject r = new JSObject();
        File f = p == null ? null : new File(p);
        boolean exists = f != null && f.exists();
        r.put("exists", exists);
        r.put("isDir", exists && f.isDirectory());
        r.put("mtime", exists ? f.lastModified() : 0);
        r.put("size", exists ? f.length() : 0);
        call.resolve(r);
    }

    @PluginMethod
    public void mkdirs(PluginCall call) {
        try {
            File f = new File(require(call, "path"));
            if (!f.isDirectory() && !f.mkdirs()) throw new IOException("Couldn't create the folder.");
            call.resolve();
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void uniquePath(PluginCall call) {
        try {
            File f = uniqueFile(new File(require(call, "dir")), call.getString("base", "Untitled"), call.getString("ext", ""));
            JSObject r = new JSObject();
            r.put("path", f.getPath());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void newFile(PluginCall call) {
        try {
            File dir = new File(require(call, "dir"));
            String base = call.getString("base", "Untitled");
            if (base == null || base.isEmpty()) base = "Untitled";
            File f = uniqueFile(dir, base, ".md");
            writeBytes(f, call.getString("content", "").getBytes(StandardCharsets.UTF_8));
            JSObject r = new JSObject();
            r.put("path", f.getPath());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void newFolder(PluginCall call) {
        try {
            File dir = new File(require(call, "dir"));
            String base = call.getString("base", "New folder");
            if (base == null || base.isEmpty()) base = "New folder";
            File f = uniqueFile(dir, base, "");
            if (!f.mkdirs()) throw new IOException("Couldn't create the folder.");
            JSObject r = new JSObject();
            r.put("path", f.getPath());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    @PluginMethod
    public void rename(PluginCall call) {
        try {
            String from = require(call, "from");
            String to = require(call, "to");
            File src = new File(from);
            File dst = new File(to);
            if (!src.exists()) throw new IOException("That file no longer exists.");
            boolean caseOnly = from.equalsIgnoreCase(to);
            if (dst.exists() && !caseOnly) throw new IOException("A file with that name already exists.");
            if (caseOnly && !from.equals(to)) {
                // shared storage is case-insensitive: go through a temporary name
                File tmp = new File(src.getParentFile(), ".folio-rename-" + System.currentTimeMillis());
                if (!src.renameTo(tmp) || !tmp.renameTo(dst)) throw new IOException("Couldn't rename.");
            } else if (!from.equals(to) && !src.renameTo(dst)) {
                throw new IOException("Couldn't rename.");
            }
            JSObject r = new JSObject();
            r.put("path", to);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    /** Android has no recycle bin for files: deleted items go to Folio's own trash folder. */
    @PluginMethod
    public void trash(PluginCall call) {
        try {
            File src = new File(require(call, "path"));
            if (!src.exists()) throw new IOException("That file no longer exists.");
            File trash = getContext().getExternalFilesDir("Trash");
            if (trash == null) trash = new File(getContext().getFilesDir(), "Trash");
            if (!trash.isDirectory() && !trash.mkdirs()) throw new IOException("Couldn't create the trash folder.");
            String stamp = new java.text.SimpleDateFormat("yyyy-MM-dd HH.mm.ss", Locale.ROOT).format(new java.util.Date());
            File target = uniqueFile(trash, stamp + " " + src.getName(), "");
            if (!src.renameTo(target)) {
                // different volume: copy, then remove the original
                copyRecursive(src, target);
                deleteRecursive(src);
            }
            JSObject r = new JSObject();
            r.put("path", target.getPath());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    // ------------------------------------------------------------------ open, share, print

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.matches("(?i)^(https?:|mailto:).*")) {
            call.reject("Blocked");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can open that link.");
        }
    }

    /** Opens a local file in another app. Folio's JS side has already refused programs/installers. */
    @PluginMethod
    public void openFile(PluginCall call) {
        try {
            File f = new File(require(call, "path"));
            if (!f.isFile()) throw new IOException("Not found");
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            String mime = mimeFor(f.getName());
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can open this file.");
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    /** Opens Android's share sheet for a file (send a page by mail, WhatsApp, Drive...). */
    @PluginMethod
    public void share(PluginCall call) {
        try {
            File f = new File(require(call, "path"));
            if (!f.isFile()) throw new IOException("Not found");
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType(mimeFor(f.getName()));
            i.putExtra(Intent.EXTRA_STREAM, uri);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(i, call.getString("title", f.getName()));
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject(message(e));
        }
    }

    /** Android's print dialog for the current page; "Save as PDF" is one of its printers. */
    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "Folio");
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                PrintDocumentAdapter adapter = getBridge().getWebView().createPrintDocumentAdapter(name);
                PrintAttributes attrs = new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build();
                pm.print(name, adapter, attrs);
                call.resolve();
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    // ------------------------------------------------------------------ helpers

    private static String require(PluginCall call, String key) throws IOException {
        String v = call.getString(key);
        if (v == null || v.isEmpty()) throw new IOException("Missing " + key);
        return v;
    }

    private static String trimSlash(String p) {
        if (p == null) return null;
        while (p.length() > 1 && p.endsWith("/")) p = p.substring(0, p.length() - 1);
        return p;
    }

    private static String message(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    private static String safeName(String name) {
        if (name == null) return "";
        return name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]+", "-").trim();
    }

    private static String mimeFor(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (ext.equals("md") || ext.equals("markdown") || ext.equals("mdown") || ext.equals("mkd") || ext.equals("mdx")) return "text/markdown";
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime == null ? "*/*" : mime;
    }

    private static File uniqueFile(File dir, String base, String ext) {
        File f = new File(dir, base + ext);
        int i = 2;
        while (f.exists()) {
            f = new File(dir, base + " " + i + ext);
            i++;
        }
        return f;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void writeBytes(File f, byte[] data) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Couldn't create the folder.");
        try (FileOutputStream out = new FileOutputStream(f, false)) {
            out.write(data);
            out.flush();
            try {
                out.getFD().sync();
            } catch (IOException ignored) {}
        }
    }

    private void copyFromUri(Uri uri, File target) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Couldn't create the folder.");
        InputStream in;
        if ("file".equals(uri.getScheme()) || uri.getScheme() == null) {
            in = new FileInputStream(new File(uri.getPath()));
        } else {
            ContentResolver cr = getContext().getContentResolver();
            in = cr.openInputStream(uri);
        }
        if (in == null) throw new IOException("Couldn't read the file.");
        try (InputStream is = in; OutputStream out = new FileOutputStream(target, false)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static void copyRecursive(File src, File dst) throws IOException {
        if (src.isDirectory()) {
            if (!dst.isDirectory() && !dst.mkdirs()) throw new IOException("Couldn't move to trash.");
            String[] names = src.list();
            if (names != null) for (String n : names) copyRecursive(new File(src, n), new File(dst, n));
        } else {
            try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        }
    }

    private static void deleteRecursive(File f) throws IOException {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        if (f.exists() && !f.delete()) throw new IOException("Couldn't remove " + f.getName());
    }
}

package dev.projdeck.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

/**
 * projdeck 的安卓外壳：全屏 WebView 打开 projdeck 网页。
 * 网页之外补上 App 才有的能力：系统栏颜色跟随网页主题、键盘弹出时让出空间、上传手机里的图片和文件、
 * 返回键回到上一页、下载文件、以及不经过谷歌推送服务的后台通知（见 NotifyService）。
 */
public class MainActivity extends Activity {
    private static final int REQ_FILES = 1;
    private static final int REQ_NOTIFY_PERMISSION = 2;

    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private boolean loginPrompted;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0a0a"));
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // 内容画到系统栏后面，再按系统栏、刘海和键盘的实际占用留出边距：键盘弹出时网页随之变矮
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });

        setUpWebView();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }
        if (Prefs.notificationsEnabled(this)) NotifyService.start(this);
        handleIntent(getIntent(), true);
    }

    private void setUpWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 系统字体缩放会打乱终端的格子，网页自己有字号设置
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " projdeck-android/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "ProjdeckApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isOurs(url)) return false;
                // 其他网站在浏览器里打开
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 系统栏颜色跟随网页的背景色（projdeck 的主题跟随电脑上的 Ghostty，可能随时变化）
                view.evaluateJavascript(
                        "(() => { if (window.__projdeckTheme) return; window.__projdeckTheme = true;"
                                + " const bg = () => [document.body, document.documentElement].map((e) => getComputedStyle(e).backgroundColor)"
                                + "   .find((c) => c !== 'transparent' && !/rgba\\(.*,\\s*0\\)$/.test(c));"
                                + " const send = () => { try { ProjdeckApp.setThemeColor(bg()); } catch (e) {} };"
                                + " send(); setTimeout(send, 800);"
                                + " new MutationObserver(send).observe(document.documentElement, { attributes: true }); })()",
                        null);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                // 没有访问 key 时服务器对所有请求返回 404：请用户提供访问链接
                if (request.isForMainFrame() && response.getStatusCode() == 404 && !loginPrompted) {
                    loginPrompted = true;
                    promptAccessLink();
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                String[] types = params.getAcceptTypes();
                if (types.length > 0 && !types[0].isEmpty()) {
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
                    if (types.length == 1) intent.setType(types[0]);
                }
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(intent, null), REQ_FILES);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        // 下载（文件管理器里的「下载」）：交给系统下载管理器，带上登录 cookie
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                req.addRequestHeader("User-Agent", userAgent);
                String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                req.setTitle(name);
                req.setMimeType(mimeType);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(this, "开始下载 " + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private static boolean isOurs(Uri url) {
        Uri base = Uri.parse(BuildConfig.SERVER);
        return base.getHost() != null && base.getHost().equals(url.getHost()) && base.getPort() == url.getPort();
    }

    /** 打开 App 的方式：桌面图标、projdeck 链接（如登录用的 /k/… 链接）、点通知（带要打开的页面）。 */
    private void handleIntent(Intent intent, boolean first) {
        Uri data = intent.getData();
        String path = intent.getStringExtra(NotifyService.EXTRA_PATH);
        if (data != null && isOurs(data)) {
            web.loadUrl(data.toString());
        } else if (path != null) {
            web.loadUrl(BuildConfig.SERVER + path);
        } else if (first) {
            web.loadUrl(BuildConfig.SERVER + "/");
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent, false);
    }

    private void goBack() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        goBack();
    }

    /** 第一次使用：粘贴电脑上的访问链接（https://…/k/…），记住登录状态。 */
    private void promptAccessLink() {
        EditText input = new EditText(this);
        input.setHint(BuildConfig.SERVER + "/k/…");
        input.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle("连接到 projdeck")
                .setMessage("请粘贴访问链接（电脑上 ~/.config/projdeck/edge-key 对应的 " + BuildConfig.SERVER + "/k/… 链接）。只需要一次。")
                .setView(input)
                .setPositiveButton("连接", (d, w) -> {
                    Uri link = Uri.parse(input.getText().toString().trim());
                    loginPrompted = false;
                    if (isOurs(link)) web.loadUrl(link.toString());
                    else Toast.makeText(this, "不是 projdeck 的链接", Toast.LENGTH_LONG).show();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILES || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] {data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_NOTIFY_PERMISSION) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) enableNotifications();
        notifyResult(ok);
    }

    private void enableNotifications() {
        Prefs.setNotifications(this, true);
        NotifyService.start(this);
    }

    private void notifyResult(boolean ok) {
        web.evaluateJavascript("window.__projdeckNotifyResult && window.__projdeckNotifyResult(" + ok + ")", null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    /** 给网页用的接口：window.ProjdeckApp。方法在后台线程调用，界面操作切回主线程。 */
    private class Bridge {
        @JavascriptInterface
        public boolean notificationsEnabled() {
            return Prefs.notificationsEnabled(MainActivity.this);
        }

        @JavascriptInterface
        public void setNotifications(boolean on) {
            runOnUiThread(() -> {
                if (!on) {
                    Prefs.setNotifications(MainActivity.this, false);
                    NotifyService.stop(MainActivity.this);
                    notifyResult(true);
                } else if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                    enableNotifications();
                    notifyResult(true);
                } else {
                    requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY_PERMISSION);
                }
            });
        }

        @JavascriptInterface
        public void setThemeColor(String css) {
            int color = parseCssColor(css);
            if (color == 0) return;
            runOnUiThread(() -> {
                root.setBackgroundColor(color);
                // 浅色背景用深色的状态栏图标
                double lum = (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color)) / 255;
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) c.setSystemBarsAppearance(lum > 0.6 ? light : 0, light);
            });
        }
    }

    /** "rgb(10, 10, 10)" / "rgba(…)" → 颜色；解析不了时为 0。 */
    static int parseCssColor(String css) {
        if (css == null) return 0;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)").matcher(css);
        if (!m.find()) return 0;
        return Color.rgb(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
    }
}

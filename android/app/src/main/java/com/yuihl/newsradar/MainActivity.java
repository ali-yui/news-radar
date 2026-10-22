package com.yuihl.newsradar;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Message;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 资讯雷达 WebView 外壳。
 * 设计要点：
 *   1) 所有 http/https 链接都在 WebView 内打开，不交给外部浏览器；
 *   2) window.open / target=_blank 也在 App 内的对话框 WebView 中打开；
 *   3) 返回键先关闭 App 内的浮层（详情页 / Trending 榜单），再退历史，最后才退出；
 *   4) 开启 DOM Storage（收藏、已读、翻译缓存都依赖 localStorage）
 *      与 file 域跨域（file:// 页面需要读取 COS / jsDelivr 的 daily.json）。
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/index.html";

    /** 若 App 内有浮层（详情页 / Trending 榜单）则先关掉它，返回 'overlay' */
    private static final String JS_CLOSE_OVERLAY =
            "(function(){try{"
                    + "var d=document.getElementById('page-detail');"
                    + "if(d&&!d.classList.contains('hidden')){"
                    + "  if(window.Detail){window.Detail.close();} return 'overlay';}"
                    + "var t=document.getElementById('trendingSheet');"
                    + "if(t&&!t.classList.contains('hidden')){"
                    + "  if(window.Trending){window.Trending.hide();} return 'overlay';}"
                    + "}catch(e){return 'none';}return 'none';})()";

    private WebView web;
    private Dialog subDialog;
    private WebView subWeb;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        applySettings(web.getSettings());
        web.setWebViewClient(new InAppClient());
        web.setWebChromeClient(new InAppChrome());
        web.setBackgroundColor(0xFFF3F1EC);
        setContentView(web);
        if (savedInstanceState == null) {
            web.loadUrl(START_URL);
        } else {
            web.restoreState(savedInstanceState);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void applySettings(WebSettings s) {
        s.setJavaScriptEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // file:// 页面要跨域取远程 daily.json（COS / jsDelivr）
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
    }

    /** http/https 一律留在 App 内；其余协议（tel/mailto/market 等）才交给系统 */
    private class InAppClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
            if ("http".equals(scheme) || "https".equals(scheme)) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // 没有可处理的应用时忽略
            }
            return true;
        }
    }

    private class InAppChrome extends WebChromeClient {
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                      Message resultMsg) {
            // window.open / target=_blank → 应用内新窗口（全屏对话框），不跳外部浏览器
            subWeb = new WebView(MainActivity.this);
            applySettings(subWeb.getSettings());
            subWeb.setWebViewClient(new InAppClient());
            subWeb.setWebChromeClient(new InAppChrome());

            Dialog d = new Dialog(MainActivity.this, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
            d.setContentView(subWeb, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            d.setOnDismissListener(dialog -> destroySub());
            d.show();
            subDialog = d;

            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(subWeb);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public void onCloseWindow(WebView window) {
            closeSub();
        }
    }

    private void closeSub() {
        if (subDialog != null) {
            subDialog.dismiss(); // onDismissListener 里会清理
            subDialog = null;
            return;
        }
        destroySub();
    }

    private void destroySub() {
        if (subWeb != null) {
            try {
                subWeb.stopLoading();
                subWeb.destroy();
            } catch (Exception ignored) {
                // 忽略销毁异常
            }
            subWeb = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (subDialog != null) {
            closeSub();
            return;
        }
        web.evaluateJavascript(JS_CLOSE_OVERLAY, value -> runOnUiThread(() -> {
            boolean closed = value != null && value.contains("overlay");
            if (closed) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        }));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        web.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        if (subDialog != null) {
            subDialog.dismiss();
            subDialog = null;
        }
        destroySub();
        super.onDestroy();
    }
}

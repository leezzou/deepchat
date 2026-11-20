package ai.deepseek.demo.shell;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.PathInterpolator;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;

/** A modal peer of the web confirmation sheet. The window fits the system bars and cutout. */
final class AccountConfirmSheet extends Dialog {
    private static final int WRAP = -2, FILL = -1;
    private static final PathInterpolator EASE = new PathInterpolator(.2f, 0f, 0f, 1f);
    private final FrameLayout overlay;
    private final ScrollView panel;
    private final boolean dark;
    private final Runnable accept;
    private boolean bottom, closing;

    AccountConfirmSheet(Activity activity, boolean dark, Runnable accept) {
        super(activity, dark ? android.R.style.Theme_Material_Dialog_NoActionBar
                : android.R.style.Theme_Material_Light_Dialog_NoActionBar);
        this.dark = dark;
        this.accept = accept;
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setTitle("退出 DeepSeek 账号？");
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, true);
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        if ((activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
        overlay = new FrameLayout(getContext());
        overlay.setBackgroundColor(dark ? 0x99000000 : 0x5c000000);
        overlay.setOnClickListener(v -> cancel());
        overlay.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        panel = new ScrollView(getContext());
        panel.setClickable(true);
        panel.setFocusable(false);
        ViewCompat.setAccessibilityPaneTitle(panel, "退出 DeepSeek 账号？");
        overlay.addView(panel);
        setContentView(overlay);
        window.setWindowAnimations(0);
        window.setLayout(FILL, FILL);
        layoutPanel(activity.getResources().getConfiguration().screenWidthDp);
        overlay.addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) -> {
            if (r - l != oldR - oldL && oldR > oldL) {
                layoutPanel(Math.round((r - l) / getContext().getResources().getDisplayMetrics().density));
            }
        });
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    private GradientDrawable shape(int color, int radius) {
        GradientDrawable result = new GradientDrawable();
        result.setColor(color);
        result.setCornerRadius(dp(radius));
        return result;
    }

    private void layoutPanel(int widthDp) {
        bottom = widthDp < 768;
        int surface = dark ? 0xff2c2c2e : Color.WHITE;
        int ink = dark ? 0xfff8f8f8 : 0xff0f0f0f;
        int border = dark ? 0xff515154 : 0xffd5d5d7;
        int danger = dark ? 0xfff25a5a : 0xffc62935;
        int radius = dp(24);
        GradientDrawable bg = shape(surface, 24);
        if (bottom) bg.setCornerRadii(new float[] {radius, radius, radius, radius, 0, 0, 0, 0});
        panel.setBackground(bg);
        panel.setClipToOutline(true);
        panel.setElevation(dp(8));
        FrameLayout.LayoutParams layout = new FrameLayout.LayoutParams(
                dp(bottom ? Math.min(widthDp, 560) : 380), WRAP, bottom ? Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL : Gravity.CENTER);
        layout.topMargin = dp(16);
        layout.bottomMargin = bottom ? 0 : dp(16);
        panel.setLayoutParams(layout);
        panel.removeAllViews();
        LinearLayout content = new LinearLayout(getContext());
        content.setOrientation(LinearLayout.VERTICAL);
        int gutter = dp(bottom ? (widthDp <= 360 ? 16 : 20) : 24);
        content.setPadding(gutter, dp(bottom ? 10 : 22), gutter, dp(bottom ? 16 : 22));
        panel.addView(content);
        if (bottom) {
            View handle = new View(getContext());
            handle.setBackground(shape(dark ? 0xff414141 : 0xffe5e5e5, 4));
            LinearLayout.LayoutParams h = new LinearLayout.LayoutParams(dp(32), dp(4));
            h.gravity = Gravity.CENTER_HORIZONTAL;
            h.bottomMargin = dp(8);
            content.addView(handle, h);
        }
        TextView title = text("退出 DeepSeek 账号？", bottom ? 18 : 16, ink);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setGravity(Gravity.CENTER_VERTICAL);
        title.setMinHeight(dp(bottom ? 48 : 24));
        ViewCompat.setAccessibilityHeading(title, true);
        content.addView(title, FILL, WRAP);
        TextView details = text("本机 API 将关闭。对话记录和 API Key 配置会保留。", 15,
                dark ? 0xffb1b3b6 : 0xff616366);
        details.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams body = new LinearLayout.LayoutParams(FILL, WRAP);
        body.topMargin = dp(bottom ? 8 : 12);
        content.addView(details, body);
        LinearLayout actions = new LinearLayout(getContext());
        actions.setGravity(Gravity.END);
        LinearLayout.LayoutParams footer = new LinearLayout.LayoutParams(FILL, WRAP);
        footer.topMargin = dp(20);
        content.addView(actions, footer);
        Button cancel = button("取消", ink, surface, border, android.R.id.button2);
        cancel.setOnClickListener(v -> cancel());
        Button confirm = button("退出登录", dark ? 0xff180909 : Color.WHITE, danger, danger, android.R.id.button1);
        confirm.setOnClickListener(v -> finish(true));
        boolean stack = widthDp < 330 || getContext().getResources().getConfiguration().fontScale > 1.3f;
        actions.setOrientation(stack ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL);
        int buttonWidth = stack ? FILL : bottom ? 0 : WRAP;
        float weight = !stack && bottom ? 1f : 0f;
        actions.addView(cancel, new LinearLayout.LayoutParams(buttonWidth, WRAP, weight));
        LinearLayout.LayoutParams confirmLayout = new LinearLayout.LayoutParams(buttonWidth, WRAP, weight);
        if (stack) confirmLayout.topMargin = dp(8);
        else confirmLayout.setMarginStart(dp(8));
        actions.addView(confirm, confirmLayout);
        cancel.requestFocus();
        Window window = getWindow();
        int dimmedPage = dark ? 0xff0c0c0c : 0xffa3a3a3;
        window.setStatusBarColor(dimmedPage);
        window.setNavigationBarColor(bottom ? surface : dimmedPage);
        if (Build.VERSION.SDK_INT >= 28) window.setNavigationBarDividerColor(bottom ? surface : dimmedPage);
        WindowCompat.getInsetsController(window, window.getDecorView()).setAppearanceLightStatusBars(!dark);
        WindowCompat.getInsetsController(window, window.getDecorView()).setAppearanceLightNavigationBars(!dark);
    }

    private TextView text(String label, int size, int color) {
        TextView view = new TextView(getContext());
        view.setText(label);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setIncludeFontPadding(false);
        return view;
    }

    private Button button(String label, int ink, int fill, int stroke, int id) {
        Button view = new Button(getContext());
        view.setId(id);
        view.setAllCaps(false);
        view.setText(label);
        view.setTextSize(14);
        view.setTextColor(ink);
        view.setMinHeight(dp(48));
        view.setMinimumHeight(dp(48));
        view.setPadding(dp(14), dp(6), dp(14), dp(6));
        GradientDrawable normal = shape(fill, 48);
        normal.setStroke(dp(1), stroke);
        view.setBackgroundTintList(null);
        view.setStateListAnimator(null);
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(dark ? 0x33ffffff : 0x22000000), normal, null));
        return view;
    }

    private boolean motion() {
        return Settings.Global.getFloat(getContext().getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0
                && Settings.Global.getFloat(getContext().getContentResolver(), Settings.Global.WINDOW_ANIMATION_SCALE, 1f) > 0;
    }

    @Override public void show() {
        super.show();
        if (!motion()) return;
        overlay.setAlpha(0f);
        panel.post(() -> {
            if (!isShowing() || closing) return;
            panel.setTranslationY(bottom ? panel.getHeight() : dp(8));
            panel.setScaleX(bottom ? 1f : .975f);
            panel.setScaleY(panel.getScaleX());
            overlay.animate().alpha(1f).setDuration(230).setInterpolator(EASE).start();
            panel.animate().translationY(0).scaleX(1f).scaleY(1f).setDuration(230).setInterpolator(EASE).start();
        });
    }

    @Override public void cancel() { finish(false); }

    private void finish(boolean confirmed) {
        if (closing || !isShowing()) return;
        closing = true;
        Runnable done = () -> {
            if (!isShowing()) return;
            dismiss();
            if (confirmed) accept.run();
        };
        if (!motion()) { done.run(); return; }
        panel.animate().translationY(bottom ? panel.getHeight() : dp(8)).scaleX(bottom ? 1f : .975f)
                .scaleY(bottom ? 1f : .975f).setDuration(180).setInterpolator(EASE).start();
        overlay.animate().alpha(0f).setDuration(180).setInterpolator(EASE).withEndAction(done).start();
    }

    // Lifecycle dismissal (lock, owner closes, Activity destroyed) also cancels a pending accept.
    @Override public void dismiss() {
        closing = true;
        overlay.animate().cancel();
        panel.animate().cancel();
        super.dismiss();
    }
}

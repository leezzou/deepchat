package ai.deepseek.demo.shell;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.math.BigDecimal;
import java.math.RoundingMode;

/** Native layout for the account dialog. All dimensions are dp; text follows the system font scale. */
final class AccountPage extends LinearLayout {
    enum Style { PRIMARY, TONAL, PLAIN, DANGER }
    private static final int MATCH = LayoutParams.MATCH_PARENT;
    private static final int WRAP = LayoutParams.WRAP_CONTENT;
    private final Window window;
    private final Runnable redraw;
    private final ImageButton back;
    private final TextView barTitle;
    private final ScrollView scroll;
    final LinearLayout body;
    boolean dark;
    int paper, panel, ink, muted, blue, onBlue, tint, rule, error;

    AccountPage(Activity activity, Window window, Runnable close, Runnable redraw) {
        super(activity);
        this.window = window;
        this.redraw = redraw;
        setOrientation(VERTICAL);
        LinearLayout bar = new LinearLayout(activity);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(8), dp(4), dp(16), dp(4));
        addView(bar, MATCH, WRAP);
        back = new ImageButton(activity);
        back.setImageResource(androidx.appcompat.R.drawable.abc_ic_ab_back_material);
        back.setScaleType(ImageView.ScaleType.CENTER);
        back.setContentDescription("返回聊天");
        back.setOnClickListener(v -> close.run());
        bar.addView(back, dp(48), dp(48));
        barTitle = text("DeepChat 账户", 18, 0, true);
        bar.addView(barTitle, paddedTop(WRAP, WRAP, 0));

        scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        addView(scroll, new LayoutParams(MATCH, 0, 1));
        FrameLayout center = new FrameLayout(activity);
        scroll.addView(center, MATCH, WRAP);
        body = new LinearLayout(activity) {
            @Override protected void onMeasure(int width, int height) {
                int capped = Math.min(MeasureSpec.getSize(width), dp(600));
                super.onMeasure(MeasureSpec.makeMeasureSpec(capped, MeasureSpec.EXACTLY), height);
            }
        };
        body.setOrientation(VERTICAL);
        center.addView(body, new FrameLayout.LayoutParams(MATCH, WRAP, Gravity.CENTER_HORIZONTAL));
        updateTheme();
    }

    private void updateTheme() {
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        paper = dark ? 0xff0f0f0f : 0xffffffff;
        panel = dark ? 0xff1c1f27 : 0xfff3f5fa;
        ink = dark ? 0xfff0f2f8 : 0xff182035;
        muted = dark ? 0xffb6bdcd : 0xff535e72;
        blue = dark ? 0xffacc0ff : 0xff355dda;
        onBlue = dark ? 0xff102655 : 0xffffffff;
        tint = dark ? 0xff263451 : 0xffebf0ff;
        rule = dark ? 0xff353a46 : 0xffd9dfeb;
        error = dark ? 0xffffb4aa : 0xffaa3029;
        setBackgroundColor(paper);
        barTitle.setTextColor(ink);
        back.setColorFilter(ink);
        back.setBackground(ripple(0, 24));
        // This non-floating window fits system bars. Old releases only draw white system icons.
        window.setStatusBarColor(!dark && Build.VERSION.SDK_INT < 23 ? 0xff28344e : paper);
        window.setNavigationBarColor(!dark && Build.VERSION.SDK_INT < 26 ? 0xff28344e : paper);
        int flags = 0;
        if (!dark && Build.VERSION.SDK_INT >= 23) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (!dark && Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        window.getDecorView().setSystemUiVisibility(flags);
        if (Build.VERSION.SDK_INT >= 29) setForceDarkAllowed(false);
    }

    @Override protected void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        updateTheme();
        post(redraw);
    }

    void reset(boolean welcome) {
        body.removeAllViews();
        boolean tall = getResources().getConfiguration().screenHeightDp >= 560;
        body.setPadding(dp(24), dp(welcome && tall ? 68 : 16), dp(24), dp(32));
    }

    void scrollToStart() { scroll.scrollTo(0, 0); }

    void logo() {
        ImageView logo = new ImageView(getContext());
        logo.setImageResource(R.mipmap.ic_launcher_round);
        logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        body.addView(logo, dp(64), dp(64));
    }

    TextView label(LinearLayout parent, String value, int size, int color, boolean medium, int top) {
        TextView label = text(value, size, color, medium);
        parent.addView(label, paddedTop(MATCH, WRAP, top));
        return label;
    }

    void heading(String value, int top) {
        TextView heading = label(body, value, 28, ink, true, top);
        if (Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
    }

    LinearLayout walletPanel() {
        LinearLayout box = new LinearLayout(getContext());
        box.setOrientation(VERTICAL);
        box.setPadding(dp(18), dp(16), dp(18), dp(16));
        box.setBackground(shape(panel, 16));
        body.addView(box, paddedTop(MATCH, WRAP, 20));
        return box;
    }

    void divider(LinearLayout parent, int top) {
        View line = new View(getContext());
        line.setBackgroundColor(rule);
        parent.addView(line, paddedTop(MATCH, dp(1), top));
    }

    void walletRow(LinearLayout parent, String currency, String rawBalance) {
        String balance = new BigDecimal(rawBalance).setScale(2, RoundingMode.HALF_UP).toPlainString();
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        // Larger font scales and long decimal amounts get independent, full-width lines.
        boolean stacked = getResources().getConfiguration().fontScale > 1.3f
                || balance.length() > 14 || currency.length() > 6;
        row.setOrientation(stacked ? VERTICAL : HORIZONTAL);
        parent.addView(row, paddedTop(MATCH, WRAP, 8));
        TextView unit = text(currency, 15, muted, false);
        row.addView(unit, stacked ? new LayoutParams(MATCH, WRAP) : new LayoutParams(0, WRAP, 1));
        TextView amount = text(balance, 22, ink, true);
        amount.setFontFeatureSettings("tnum");
        row.addView(amount, stacked ? MATCH : WRAP, WRAP);
    }

    void button(LinearLayout parent, String title, Style style, int top, Runnable action) {
        Button button = new Button(getContext());
        button.setAllCaps(false);
        button.setText(title);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setGravity(Gravity.CENTER);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(dp(48));
        button.setMinimumHeight(dp(48));
        button.setPadding(dp(10), dp(10), dp(10), dp(10));
        button.setStateListAnimator(null);
        button.setBackgroundTintList(null);
        int background = style == Style.PRIMARY ? blue : style == Style.TONAL ? tint : 0;
        int foreground = style == Style.PRIMARY ? onBlue : style == Style.DANGER ? error : blue;
        button.setTextColor(action == null ? muted : foreground);
        button.setBackground(ripple(action == null ? panel : background, 12));
        button.setEnabled(action != null);
        if (action != null) button.setOnClickListener(v -> action.run());
        boolean horizontal = parent.getOrientation() == HORIZONTAL;
        LayoutParams lp = horizontal ? new LayoutParams(0, WRAP, 1) : paddedTop(MATCH, WRAP, top);
        if (horizontal && parent.getChildCount() > 0) lp.setMarginStart(dp(8));
        parent.addView(button, lp);
    }

    LinearLayout actionRow(LinearLayout parent, int top) {
        LinearLayout row = new LinearLayout(getContext());
        boolean compact = getResources().getConfiguration().screenWidthDp < 330
                || getResources().getConfiguration().fontScale > 1.3f;
        row.setOrientation(compact ? VERTICAL : HORIZONTAL);
        parent.addView(row, paddedTop(MATCH, WRAP, top));
        return row;
    }

    private TextView text(String value, int sp, int color, boolean medium) {
        TextView t = new TextView(getContext());
        t.setText(value);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setTypeface(Typeface.create(medium ? "sans-serif-medium" : "sans-serif", Typeface.NORMAL));
        t.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        return t;
    }

    private RippleDrawable ripple(int fill, int radius) {
        int wash = dark ? 0x38b8c9ff : 0x28426efe;
        return new RippleDrawable(ColorStateList.valueOf(wash), shape(fill, radius), shape(0xffffffff, radius));
    }

    private GradientDrawable shape(int fill, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(radius));
        return d;
    }

    private LayoutParams paddedTop(int w, int h, int top) {
        LayoutParams lp = new LayoutParams(w, h);
        lp.topMargin = dp(top);
        return lp;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}

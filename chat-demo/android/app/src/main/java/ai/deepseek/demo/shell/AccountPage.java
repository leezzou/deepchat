package ai.deepseek.demo.shell;

import android.app.Activity;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.text.TextUtils;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
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
    private final SystemBars theme;
    private final ImageButton back;
    private final TextView barTitle;
    private final ScrollView scroll;
    final LinearLayout body;
    boolean dark;
    int paper, panel, ink, muted, blue, onBlue, tint, rule, error;

    AccountPage(Activity activity, Window window, SystemBars theme, String title, Runnable close, Runnable redraw) {
        super(activity);
        this.window = window;
        this.theme = theme;
        this.redraw = redraw;
        setOrientation(VERTICAL);
        FrameLayout bar = new FrameLayout(activity);
        bar.setMinimumHeight(dp(56));
        bar.setPadding(dp(8), 0, dp(8), 0);
        addView(bar, MATCH, WRAP);
        back = new ImageButton(activity);
        back.setImageResource(R.drawable.account_chevron);
        back.setScaleX(-1f);
        back.setScaleType(ImageView.ScaleType.CENTER);
        back.setContentDescription("返回");
        back.setOnClickListener(v -> close.run());
        bar.addView(back, new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.START | Gravity.CENTER_VERTICAL));
        barTitle = text(title, 18, 0, true);
        barTitle.setGravity(Gravity.CENTER);
        if (Build.VERSION.SDK_INT >= 28) barTitle.setAccessibilityHeading(true);
        FrameLayout.LayoutParams titleParams = new FrameLayout.LayoutParams(MATCH, WRAP, Gravity.CENTER);
        titleParams.setMarginStart(dp(54));
        titleParams.setMarginEnd(dp(54));
        bar.addView(barTitle, titleParams);

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

    void updateTheme() {
        dark = theme.isAppDark();
        paper = dark ? 0xff1e1e1e : 0xfff8f8f8;
        panel = dark ? 0xff292929 : 0xffffffff;
        ink = dark ? 0xfff8f8f8 : 0xff0f0f0f;
        muted = dark ? 0xffb1b3b6 : 0xff616366;
        blue = dark ? 0xff98b6ff : 0xff345cdb;
        onBlue = dark ? 0xff151e35 : 0xffffffff;
        tint = dark ? 0xff363636 : 0xfff1f1f1;
        rule = dark ? 0xff414141 : 0xffe5e5e5;
        error = dark ? 0xffffa6a6 : 0xffb32a37;
        setBackgroundColor(paper);
        barTitle.setTextColor(ink);
        back.setColorFilter(ink);
        back.setBackground(new InsetDrawable(ripple(dark ? 0xff3c3c3d : 0xffededed, 20), dp(4)));
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

    void reset() {
        body.removeAllViews();
        int side = dp(getResources().getConfiguration().screenWidthDp < 360 ? 16 : 20);
        body.setPadding(side, dp(14), side, dp(28));
    }

    void scrollToStart() { scroll.scrollTo(0, 0); }

    private ImageView picture;

    void identity(LinearLayout parent, String title, String detail, String initial, Bitmap photo) {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        parent.addView(row, MATCH, WRAP);
        FrameLayout avatar = new FrameLayout(getContext());
        avatar.setBackground(shape(dark ? 0xff283142 : 0xffedf3fe, 24));
        avatar.setClipToOutline(true);
        avatar.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        row.addView(avatar, dp(48), dp(48));
        TextView letter = text(initial.isEmpty() ? "D" : initial, 21, blue, true);
        letter.setGravity(Gravity.CENTER);
        avatar.addView(letter, MATCH, MATCH);
        picture = new ImageView(getContext());
        picture.setScaleType(ImageView.ScaleType.CENTER_CROP);
        avatar.addView(picture, MATCH, MATCH);
        setPhoto(photo);
        LinearLayout copy = new LinearLayout(getContext());
        copy.setOrientation(VERTICAL);
        LayoutParams copyLayout = new LayoutParams(0, WRAP, 1);
        copyLayout.setMarginStart(dp(14));
        row.addView(copy, copyLayout);
        TextView name = label(copy, title, 20, ink, true, 0);
        name.setMaxLines(2);
        name.setEllipsize(TextUtils.TruncateAt.END);
        if (Build.VERSION.SDK_INT >= 28) name.setAccessibilityHeading(true);
        label(copy, detail, 14, muted, false, 3);
    }

    void setPhoto(Bitmap photo) {
        if (picture != null) picture.setImageBitmap(photo);
    }

    TextView label(LinearLayout parent, String value, int size, int color, boolean medium, int top) {
        TextView label = text(value, size, color, medium);
        parent.addView(label, paddedTop(MATCH, WRAP, top));
        return label;
    }

    void section(String title, int top) {
        TextView heading = label(body, title, 14, muted, true, top);
        if (Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
    }

    LinearLayout panel(int top, boolean inset) {
        LinearLayout box = new LinearLayout(getContext());
        box.setOrientation(VERTICAL);
        if (inset) box.setPadding(dp(16), dp(16), dp(16), dp(16));
        box.setBackground(shape(panel, 16));
        box.setClipToOutline(true);
        body.addView(box, paddedTop(MATCH, WRAP, top));
        return box;
    }

    void divider(LinearLayout parent, int top) {
        View line = new View(getContext());
        line.setBackgroundColor(rule);
        parent.addView(line, paddedTop(MATCH, dp(1), top));
    }

    void balanceLine(LinearLayout parent, String title, String value, boolean money) {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(44));
        row.setPadding(0, dp(4), 0, dp(4));
        boolean stacked = getResources().getConfiguration().fontScale > 1.3f || value.length() > 16;
        row.setOrientation(stacked ? VERTICAL : HORIZONTAL);
        parent.addView(row, MATCH, WRAP);
        TextView label = text(title, 15, ink, false);
        row.addView(label, stacked ? new LayoutParams(MATCH, WRAP) : new LayoutParams(0, WRAP, 1));
        TextView amount = text(value, money ? 19 : 14, money ? ink : muted, money);
        amount.setFontFeatureSettings("tnum");
        row.addView(amount, stacked ? MATCH : WRAP, WRAP);
    }

    void walletRow(LinearLayout parent, String title, String currency, String rawBalance) {
        String balance = new BigDecimal(rawBalance).setScale(2, RoundingMode.HALF_UP).toPlainString();
        balanceLine(parent, title, balance + " " + currency, true);
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
        button.setBackground(ripple(action == null ? tint : background, 12));
        button.setEnabled(action != null);
        if (action != null) button.setOnClickListener(v -> action.run());
        boolean horizontal = parent.getOrientation() == HORIZONTAL;
        LayoutParams lp = horizontal ? new LayoutParams(0, WRAP, 1) : paddedTop(MATCH, WRAP, top);
        if (horizontal && parent.getChildCount() > 0) lp.setMarginStart(dp(8));
        parent.addView(button, lp);
    }

    void navigationRow(LinearLayout parent, String label, Runnable action) {
        Button row = new Button(getContext());
        row.setText(label);
        row.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        row.setTextColor(action == null ? muted : ink);
        row.setAllCaps(false);
        row.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        row.setMinHeight(dp(54));
        row.setMinimumHeight(dp(54));
        row.setStateListAnimator(null);
        row.setPaddingRelative(dp(16), dp(8), dp(16), dp(8));
        row.setBackgroundTintList(null);
        row.setBackground(ripple(0, 0));
        Drawable chevron = getContext().getDrawable(R.drawable.account_chevron).mutate();
        chevron.setTint(muted);
        row.setCompoundDrawablesRelativeWithIntrinsicBounds(null, null, chevron, null);
        row.setEnabled(action != null);
        if (action != null) row.setOnClickListener(v -> action.run());
        parent.addView(row, MATCH, WRAP);
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

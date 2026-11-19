package ai.deepseek.demo.shell;

import android.animation.ValueAnimator;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.os.Build;
import android.provider.Settings;
import android.view.ContextThemeWrapper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.util.Locale;

/** Presentation only. The host decides when the protected content may be visible. */
final class AppLockCover extends FrameLayout {
    private final SharedPreferences preferences;
    private final Runnable onUnlock;
    private View message;
    private Button action;
    private TextView hint;
    private int hintId = R.string.app_lock_hint;
    private boolean busy, covered, foreground;
    private int generation;

    AppLockCover(Context context, SharedPreferences preferences, Runnable onUnlock) {
        super(context);
        this.preferences = preferences;
        this.onUnlock = onUnlock;
        setClickable(true);
        setVisibility(GONE);
        inflateContent();
    }

    void saveAppearance(String theme, String locale) {
        if (!(theme.equals("system") || theme.equals("dark") || theme.equals("light"))
                || !(locale.equals("system") || locale.equals("zh-CN") || locale.equals("en-US"))) return;
        if (theme.equals(preferences.getString("theme", "system"))
                && locale.equals(preferences.getString("locale", "system"))) return;
        preferences.edit().putString("theme", theme).putString("locale", locale).apply();
        inflateContent();
    }

    @Override protected void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        inflateContent();
    }

    private void inflateContent() {
        stopMotion();
        setVisibility(covered ? VISIBLE : GONE);
        Configuration config = new Configuration(getResources().getConfiguration());
        String theme = preferences.getString("theme", "system");
        if (!"system".equals(theme)) {
            config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) |
                    ("dark".equals(theme) ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
        }
        String locale = preferences.getString("locale", "system");
        if (!"system".equals(locale)) config.setLocale(Locale.forLanguageTag(locale));
        Context context = new ContextThemeWrapper(getContext().createConfigurationContext(config), R.style.AppTheme_NoActionBar);
        removeAllViews();
        LayoutInflater.from(context).inflate(R.layout.app_lock_cover, this, true);
        message = findViewById(R.id.lock_message);
        hint = findViewById(R.id.lock_hint);
        action = findViewById(R.id.lock_unlock);
        action.setOnClickListener(v -> onUnlock.run());
        setBusy(busy);
        setHint(hintId);
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int maxAction = Math.round(420 * getResources().getDisplayMetrics().density);
        int gutter = Math.round(48 * getResources().getDisplayMetrics().density);
        action.getLayoutParams().width = Math.min(maxAction, Math.max(0, MeasureSpec.getSize(widthSpec) - gutter));
        super.onMeasure(widthSpec, heightSpec);
    }

    void setHint(int id) { hintId = id; hint.setText(id); }
    boolean isDark() {
        return (hint.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }
    String promptTitle() { return hint.getResources().getString(R.string.app_lock_prompt); }
    void setBusy(boolean value) {
        busy = value;
        action.setEnabled(!busy);
        action.setAlpha(busy ? 0.55f : 1f);
    }

    private boolean motionEnabled() {
        if (Build.VERSION.SDK_INT >= 26) return ValueAnimator.areAnimatorsEnabled();
        return Settings.Global.getFloat(getContext().getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f;
    }

    private void stopMotion() {
        ++generation;
        animate().cancel();
        setAlpha(1f);
        if (message != null) {
            message.animate().cancel();
            message.setAlpha(1f);
            message.setTranslationY(0f);
        }
    }

    void present(boolean locked, boolean resumed, boolean authenticated) {
        boolean enter = locked && resumed && (!covered || !foreground);
        boolean leave = covered && !locked && resumed && authenticated;
        boolean wasCovered = covered;
        covered = locked;
        foreground = resumed;
        float density = getResources().getDisplayMetrics().density;
        if (locked) {
            // Restore opacity synchronously, including when relocking during an exit animation.
            if (enter || !wasCovered || !resumed) stopMotion();
            setVisibility(VISIBLE);
            bringToFront();
            if (enter && motionEnabled()) {
                message.setAlpha(0.2f);
                message.setTranslationY(12f * density);
                message.animate().alpha(1f).translationY(0f).setDuration(240)
                        .setInterpolator(new DecelerateInterpolator(1.7f)).start();
            }
        } else if (leave && motionEnabled()) {
            stopMotion();
            final int run = generation;
            message.animate().translationY(-8f * density).setDuration(180).start();
            animate().alpha(0f).setDuration(180).withEndAction(() -> {
                if (generation == run && !covered) setVisibility(GONE);
            }).start();
        } else if (!resumed || wasCovered) {
            stopMotion();
            setVisibility(GONE);
        }
    }
}

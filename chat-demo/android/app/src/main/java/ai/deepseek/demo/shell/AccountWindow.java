package ai.deepseek.demo.shell;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.PathInterpolator;

/** A native page above its caller. Keep the window modal until the last exit frame. */
final class AccountWindow extends Dialog {
    private final Runnable focusChanged;
    private View content;
    private boolean leaving;

    AccountWindow(Activity activity, boolean dark, Runnable focusChanged) {
        super(activity, dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        this.focusChanged = focusChanged;
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window window = getWindow();
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        if ((activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
    }

    @Override public void setContentView(View view) {
        content = view;
        super.setContentView(view);
        getWindow().setWindowAnimations(0);
    }

    @Override public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focusChanged != null) focusChanged.run();
    }

    boolean isActive() { return isShowing() && !leaving; }

    private boolean motionEnabled() {
        // ViewPropertyAnimator itself applies the device's animator duration scale.
        return Settings.Global.getFloat(getContext().getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0
                && Settings.Global.getFloat(getContext().getContentResolver(), Settings.Global.WINDOW_ANIMATION_SCALE, 1f) > 0;
    }

    private float offset(boolean behind) {
        float direction = content.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL ? -1f : 1f;
        return direction * (behind ? -24 : 56) * content.getResources().getDisplayMetrics().density;
    }

    void reveal(boolean fromChild) {
        boolean reversing = leaving && isShowing();
        content.animate().cancel();
        leaving = false;
        super.show();
        getWindow().setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
        if (!motionEnabled()) {
            content.setTranslationX(0);
            content.setAlpha(1);
            return;
        }
        if (!reversing) {
            content.setTranslationX(offset(fromChild));
            content.setAlpha(0f);
        }
        content.animate().translationX(0).alpha(1).setDuration(220)
                .setInterpolator(new PathInterpolator(.2f, 0f, 0f, 1f)).start();
    }

    void hideForUsage() { leave(true); }
    @Override public void dismiss() { leave(false); }

    private void leave(boolean toChild) {
        if (!isActive()) return;
        leaving = true;
        content.animate().cancel();
        Runnable finish = () -> {
            if (!leaving) return;
            if (toChild) super.hide(); else super.dismiss();
        };
        if (motionEnabled()) {
            content.animate().translationX(offset(toChild)).alpha(0).setDuration(165)
                    .setInterpolator(new PathInterpolator(.3f, 0f, .8f, .5f)).withEndAction(finish).start();
        } else finish.run();
    }

    void dismissNow() {
        leaving = false;
        if (content != null) content.animate().cancel();
        super.dismiss();
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        return leaving || super.dispatchTouchEvent(event);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        return leaving || super.dispatchKeyEvent(event);
    }
}

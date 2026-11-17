package ai.deepseek.demo.shell;

import android.content.pm.PackageManager;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private SystemBars systemBars;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        systemBars = new SystemBars(this);
        // 暴露给 Web 端：主题改系统栏配色、点语音时申请录音权限
        getBridge().getWebView().addJavascriptInterface(systemBars, "AndroidSystemBars");
        // 应用内更新：下载 Release 里的 APK 并拉起系统安装器
        getBridge().getWebView().addJavascriptInterface(new Updater(this), "AndroidUpdater");
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == SystemBars.MIC_REQUEST_CODE && systemBars != null) {
            boolean granted =
                    grantResults.length > 0
                            && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            systemBars.notifyMicrophone(granted);
        }
    }
}

package ai.deepseek.demo.shell;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/** Android may batch this work. The same per-day gate also runs on foreground resume. */
public final class WorkBuddyCheckInJob extends JobService {
    private static final int JOB = 0x57424349;
    private volatile JobParameters current;
    static void schedule(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        JobInfo info = new JobInfo.Builder(JOB, new ComponentName(context, WorkBuddyCheckInJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).setPeriodic(3 * 3600_000L).build();
        if (scheduler == null || scheduler.schedule(info) != JobScheduler.RESULT_SUCCESS) throw new IllegalStateException("schedule");
    }
    static void cancel(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) scheduler.cancel(JOB);
    }
    @Override public boolean onStartJob(JobParameters params) {
        current = params;
        WorkBuddyWallet.isolated(() -> {
            if (current != params) return;
            try { WorkBuddyWallet.run(getApplicationContext(), false, null, true); }
            catch (Exception unavailable) { /* A later foreground visit can catch up. */ }
            if (current == params) { current = null; jobFinished(params, false); }
        });
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) { current = null; return true; }
}

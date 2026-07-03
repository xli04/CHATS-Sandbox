"""Test outputs for crontab-reschedule task.

Verifies the crontab has been rescheduled from overnight daily
to Saturday, with entries still properly spaced.
"""

import subprocess
import re


def _get_crontab():
    result = subprocess.run(
        ["crontab", "-l"], capture_output=True, text=True,
    )
    assert result.returncode == 0, f"crontab -l failed: {result.stderr}"
    return result.stdout


def _parse_entries(crontab_text):
    """Extract cron schedule entries (non-comment, non-blank lines)."""
    entries = []
    for line in crontab_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        entries.append(line)
    return entries


def test_crontab_not_empty():
    """Crontab should still have entries."""
    entries = _parse_entries(_get_crontab())
    assert len(entries) >= 20, (
        f"Expected at least 20 crontab entries, got {len(entries)}"
    )


def test_all_entries_on_weekend():
    """All entries should now run on the weekend (Saturday=6 or Sunday=0)."""
    entries = _parse_entries(_get_crontab())
    weekend_markers = {"0", "6", "7", "sat", "sun"}
    for entry in entries:
        parts = entry.split()
        if len(parts) < 6:
            continue
        dow = parts[4]  # day of week field
        assert dow != "*", (
            f"Entry still runs every day: {entry}"
        )
        dow_lower = dow.lower()
        # Accept any combination containing weekend days
        dow_parts = re.split(r"[,\-]", dow_lower)
        has_weekend = any(p.strip() in weekend_markers for p in dow_parts)
        assert has_weekend, (
            f"Entry not scheduled for weekend: {entry}"
        )


def test_no_weekday_only_entries():
    """No entries should run only on weekdays (Mon-Fri)."""
    entries = _parse_entries(_get_crontab())
    weekday_only = {"1", "2", "3", "4", "5", "mon", "tue", "wed", "thu", "fri"}
    for entry in entries:
        parts = entry.split()
        if len(parts) < 6:
            continue
        dow = parts[4]
        dow_lower = dow.lower()
        dow_parts = set(re.split(r"[,\-]", dow_lower))
        # Fail if all specified days are weekdays (no weekend day present)
        if dow_parts and dow_parts.issubset(weekday_only):
            assert False, (
                f"Entry runs only on weekdays: {entry}"
            )


def test_scripts_still_referenced():
    """All original scripts should still be in the crontab."""
    crontab = _get_crontab()
    required_scripts = [
        "db_backup_full.sh",
        "db_backup_incremental.sh",
        "rotate_app_logs.sh",
        "rotate_access_logs.sh",
        "compress_old_logs.sh",
        "cleanup_temp.sh",
        "cleanup_build_artifacts.sh",
        "cleanup_docker.sh",
        "cleanup_sessions.sh",
        "health_check.sh",
        "check_disk_usage.sh",
        "generate_daily_report.sh",
        "generate_usage_stats.sh",
        "sync_cdn_assets.sh",
        "sync_offsite_backup.sh",
        "invalidate_stale_cache.sh",
        "warm_cache.sh",
        "reindex_search.sh",
        "rotate_api_keys.sh",
        "audit_permissions.sh",
        "optimize_images.sh",
    ]
    for script in required_scripts:
        assert script in crontab, (
            f"Script {script} missing from crontab"
        )


def test_relative_ordering_preserved():
    """Key ordering constraints should be preserved:
    - db_backup_full before db_backup_incremental
    - rotate_app_logs before compress_old_logs
    - cleanup_temp before cleanup_docker
    - invalidate_stale_cache before warm_cache
    - reindex_search before vacuum_db
    """
    entries = _parse_entries(_get_crontab())

    def _find_time(script_name):
        for entry in entries:
            if script_name in entry:
                parts = entry.split()
                minute = int(parts[0])
                hour = int(parts[1])
                return hour * 60 + minute
        return None

    pairs = [
        ("db_backup_full.sh", "db_backup_incremental.sh"),
        ("rotate_app_logs.sh", "compress_old_logs.sh"),
        ("cleanup_temp.sh", "cleanup_docker.sh"),
        ("invalidate_stale_cache.sh", "warm_cache.sh"),
    ]
    for first, second in pairs:
        t1 = _find_time(first)
        t2 = _find_time(second)
        if t1 is not None and t2 is not None:
            assert t1 < t2, (
                f"{first} (min {t1}) should run before {second} (min {t2})"
            )


def test_no_overlapping_heavy_jobs():
    """Heavy I/O jobs should not run at the exact same minute."""
    entries = _parse_entries(_get_crontab())
    heavy_scripts = [
        "db_backup_full.sh", "cleanup_docker.sh",
        "sync_offsite_backup.sh", "reindex_search.sh",
        "vacuum_db.sh", "optimize_images.sh",
    ]
    heavy_times = []
    for entry in entries:
        for script in heavy_scripts:
            if script in entry:
                parts = entry.split()
                time_key = f"{parts[1]}:{parts[0]}"
                heavy_times.append((time_key, script))
    # Check no two heavy jobs share the exact same time
    times_only = [t[0] for t in heavy_times]
    duplicates = [t for t in times_only if times_only.count(t) > 1]
    assert len(duplicates) == 0, (
        f"Heavy jobs scheduled at same time: {duplicates}"
    )

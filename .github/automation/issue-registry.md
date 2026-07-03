# Issue Registry

<!-- automation-role:issue-registry-pr -->

このPRはIssue登録履歴専用であり、実装修正を含まず、代表PRとは別管理で、mainへはマージしない。

## Active records

| Issue | Status | Action | Target SHA | Fingerprint | Registered at | Check / Job | 00分修正タスクへの要点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #66 | open | check失敗Issue作成 | main `29d29ab0d94d1e01db88ee051249eaf4266bc895` | `stationhead-main-workflow-run-missing-29d29ab0` | 2026-07-04T01:23:09+09:00 | main validation / validation-discovery | 最新main SHAでworkflow runが空。main push条件、Cloudflare diagnostics、GitHub Checks/status公開経路、connector可視性を優先確認する。 |

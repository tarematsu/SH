# Stationhead email recap automation

1. Apply `database/email-recap-streams.sql` to the remote D1 database.
2. Deploy the Worker from `worker/`.
3. Add the Worker secret `EMAIL_RECAP_SECRET` with `wrangler secret put`.
4. Create a standalone Google Apps Script project.
5. Copy `Code.gs` from the supplied project bundle and use the repository `appsscript.json` manifest.
6. Add script property `EMAIL_RECAP_SECRET` with the same value as the Worker secret.
7. Run `testLatestStationheadRecap` once, then run `setupStationheadRecap` once.

The Apps Script runs every six hours. It sends only message ID, subject, week, email send timestamp, stream count, and timing offset. The email body is parsed locally and is not transmitted.

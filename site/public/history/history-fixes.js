/* Focused UI fixes for the official Stationhead history view. */
MODE_HELP.broadcasts = ['公式ステヘ', '過去の公式Stationhead放送を放送単位で表示します。'];

rowDate = function rowDateWithBroadcastStart(row) {
  return row?.ranking_date
    || row?.period_key
    || row?.started_jst
    || row?.observed_jst
    || row?.observed_at
    || '';
};

const setModeBase = setMode;
setMode = function setModeWithOfficialBroadcastChart(mode) {
  setModeBase(mode);
  if (mode !== 'broadcasts') return;

  $('#metric').hidden = true;
  $('#metric').disabled = true;
  $('#chartPanel').hidden = false;
  $('#chartTitle').textContent = '公式ステヘ 最大同接推移';
  $('#chartFoot').textContent = '各公式ステヘの最大同接を開始日時順に表示します。';
  $('#tableTitle').textContent = '公式ステヘ一覧';
};

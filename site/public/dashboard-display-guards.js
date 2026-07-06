(() => {
  const baseRenderPrediction = renderPrediction;
  const baseDrawChart = drawChart;
  let lastGoalPrediction = null;
  let lastPredictionGoal = null;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function validPrediction(prediction) {
    return prediction
      && finite(prediction.eta) != null
      && finite(prediction.rate_per_hour) != null
      && finite(prediction.rate_per_hour) > 0;
  }

  function sameGoal(goal) {
    const nextGoal = finite(goal);
    return nextGoal == null
      || lastPredictionGoal == null
      || nextGoal === lastPredictionGoal;
  }

  renderPrediction = function renderPredictionWithFallback(prediction, current, goal) {
    const currentValue = finite(current) ?? 0;
    const goalValue = finite(goal) ?? 0;
    let selected = prediction;

    if (validPrediction(prediction)) {
      lastGoalPrediction = structuredClone(prediction);
      lastPredictionGoal = goalValue || null;
    } else if (goalValue > 0 && currentValue < goalValue && lastGoalPrediction && sameGoal(goalValue)) {
      selected = structuredClone(lastGoalPrediction);
    } else if (goalValue > 0 && currentValue >= goalValue) {
      lastGoalPrediction = null;
      lastPredictionGoal = null;
    }

    return baseRenderPrediction(selected, current, goal);
  };

  drawChart = function drawChartWithCommentVelocityState(rows = lastHistoryRows, selectionIndex = selectedMainChartIndex) {
    baseDrawChart(rows, selectionIndex);
    const sampled = mainChartState?.sampled || (typeof downsampleRows === 'function' ? downsampleRows(rows) : rows) || [];
    const values = sampled.map((row) => {
      const value = finite(row?.comment_velocity);
      return value == null ? null : Math.max(0, value);
    });
    const maximum = values.reduce((max, value) => (
      Number.isFinite(value) ? Math.max(max, value) : max
    ), 0);
    if (mainChartState) {
      mainChartState.commentVelocityValues = values;
      mainChartState.commentVelocityMax = maximum;
    }
  };
})();

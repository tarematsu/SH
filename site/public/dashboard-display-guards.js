(() => {
  const baseRenderPrediction = renderPrediction;
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
})();

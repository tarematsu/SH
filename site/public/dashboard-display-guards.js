(() => {
  const baseRenderPrediction = renderPrediction;
  let lastGoalPrediction = null;
  let lastPredictionGoal = null;
  let lastGoalPredictions = null;

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

  renderPrediction = function renderPredictionWithFallback(prediction, current, goal, predictions) {
    const currentValue = finite(current) ?? 0;
    const goalValue = finite(goal) ?? 0;
    let selected = prediction;
    const selectedPredictions = Array.isArray(predictions) && predictions.length
      ? predictions
      : lastGoalPredictions;

    if (validPrediction(prediction)) {
      lastGoalPrediction = structuredClone(prediction);
      lastPredictionGoal = goalValue || null;
      if (Array.isArray(predictions) && predictions.length) {
        lastGoalPredictions = structuredClone(predictions);
      }
    } else if (goalValue > 0 && currentValue < goalValue && lastGoalPrediction && sameGoal(goalValue)) {
      selected = structuredClone(lastGoalPrediction);
    } else if (goalValue > 0 && currentValue >= goalValue) {
      lastGoalPrediction = null;
      lastPredictionGoal = null;
    }

    return baseRenderPrediction(selected, current, goal, selectedPredictions);
  };
})();

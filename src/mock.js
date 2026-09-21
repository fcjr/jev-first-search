// A stand-in for Jev, for people without a TYPESAFE_API_KEY.
// It answers like Jev would if Jev were a queue: first frontier node, every time.
// Asked for a distance, it makes one up.
// Latency and confidence are made up in the documented 70-500 ms range.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockJev {
  constructor({ latency = true, giveUpAfter = Infinity, reachable = 0.91 } = {}) {
    this.latency = latency;
    this.giveUpAfter = giveUpAfter;
    this.reachable = reachable;
    this.calls = 0;
  }

  async systemOne({ state, questions }) {
    this.calls += 1;
    if (this.latency) await sleep(70 + Math.random() * 430);

    const answers = {};
    for (const [name, question] of Object.entries(questions)) {
      if (question.type === 'noul') {
        answers[name] = { type: 'noul', noul: this.reachable };
        continue;
      }
      if (question.type === 'score') {
        const n = question.criteria.length;
        const value = Math.random() * (n - 1);
        const probabilities = Object.fromEntries(question.criteria.map((_, i) => [i, 1 / n]));
        answers[name] = { type: 'score', score: value, confidence: 0.3 + Math.random() * 0.3, legend: {}, probabilities };
        continue;
      }
      const labels = Object.keys(question.criteria);
      const pick = this.calls > this.giveUpAfter ? 'give_up' : labels[0];
      const confidence = 0.55 + Math.random() * 0.4;
      const rest = (1 - confidence) / Math.max(labels.length - 1, 1);
      answers[name] = {
        type: 'choice',
        choice: pick,
        confidence,
        probabilities: Object.fromEntries(labels.map((l) => [l, l === pick ? confidence : rest])),
      };
    }

    return {
      model: 'jev-mock',
      answers,
      usage: { input_tokens: 40 + JSON.stringify(state).length / 4, output_tokens: 0 },
    };
  }
}

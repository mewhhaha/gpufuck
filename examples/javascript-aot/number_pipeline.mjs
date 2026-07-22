function factorial(value) {
  if (value === 0) {
    return 1;
  }
  return value * factorial(value - 1);
}

function choose(condition, consequent, alternate) {
  return condition ? consequent : alternate;
}

export function main() {
  const factorialOfFive = factorial(5);
  const answer = choose(factorialOfFive > 100, factorialOfFive / 5 + 18, 0);
  return answer;
}

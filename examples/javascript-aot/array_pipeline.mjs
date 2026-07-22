export function main() {
  const scaled = [1, 2, 3].map(function (value) {
    return value * 2;
  });
  return scaled.reduce(function (total, value) {
    return total + value;
  }, 30);
}

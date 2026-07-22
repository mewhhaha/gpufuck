function makeAdder(offset) {
  return function (value) {
    return value + offset;
  };
}

export function main() {
  const addTwo = makeAdder(2);
  return addTwo(40);
}

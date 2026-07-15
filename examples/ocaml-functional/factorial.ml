let rec factorial value =
  if value = 0 then 1 else value * factorial (value - 1)

let gpu_main = factorial 5

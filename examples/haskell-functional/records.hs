module Records where

data Point = Point { x :: Int, y :: Int }

sumPoint :: Point -> Int
sumPoint point =
    case point of
        Point { x = left, y = right } -> left + right

gpuMain =
    let point = Point { y = 22, x = 20 }
    in if x point == 20 then
        if y point == 22 then sumPoint point else 0
    else 0

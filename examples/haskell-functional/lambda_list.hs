{-# LANGUAGE GADTs #-}
module LambdaList where

mapList :: (a -> b) -> [a] -> [b]
mapList function values =
    case values of
        [] -> []
        headValue : tailValues -> function headValue : mapList function tailValues

sumList :: [Int] -> Int
sumList values =
    case values of
        [] -> 0
        headValue : tailValues -> headValue + sumList tailValues

gpuMain = sumList (mapList (\value -> value + 1) [19, 21])

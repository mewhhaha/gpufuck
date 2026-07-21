{-# LANGUAGE RankNTypes #-}

module Frontend where

type Score = Int

newtype Identity a = Identity a

unwrap :: Identity a -> a
unwrap (Identity value) = value

lengthString :: String -> Int
lengthString [] = 0
lengthString (_ : rest) = 1 + lengthString rest

identity :: forall a. a -> a
identity value = value

useIdentity :: (forall a. a -> a) -> Score
useIdentity function = if function True then function 42 else 0

gpuMain =
    let evenLocal value = if value == 0 then True else oddLocal (value - 1)
        oddLocal value = if value == 0 then False else evenLocal (value - 1)
    in if evenLocal (lengthString "GPU!")
        then unwrap (Identity (useIdentity identity))
        else 0

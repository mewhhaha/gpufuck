module TypeProfile where;

import Prelude;

newtype Compose f g a = Compose (f (g a));

class Convert a b | a -> b where {
  convert :: a -> b;
};

instance convertIntString :: Convert Int String where {
  convert = show;
};

getX :: forall r. { x :: Int | r } -> Int;
getX record = record.x;

applyTwice :: (forall a. a -> a) -> Tuple Int Boolean;
applyTwice identity = Tuple (identity 42) (identity true);

main :: Int;
main = case applyTwice identity of {
  Tuple answer condition -> if condition then answer else 0;
};

import Data.Vect

appendLength : Nat -> Nat -> Nat
appendLength Z right = right
appendLength (S left) right = S (appendLength left right)

resultType : Type
resultType = Vect (appendLength (S (S Z)) (S Z)) Int

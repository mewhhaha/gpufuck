const std = @import("std");

fn Matrix(comptime T: type, comptime rows: usize, comptime columns: usize) type {
    return [rows][columns]T;
}

fn cellCount(comptime rows: usize, comptime columns: usize) usize {
    return rows * columns;
}

const Result = Matrix(i32, 6, 7);

test "comptime constructs the matrix type and cell count" {
    try std.testing.expectEqual(@as(usize, 168), @sizeOf(Result));
    try std.testing.expectEqual(@as(usize, 42), cellCount(6, 7));
}

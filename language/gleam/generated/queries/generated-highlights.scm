"#" @operator
"&&" @operator
"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"->" @operator
"." @punctuation.delimiter
".." @operator
":" @punctuation.delimiter
"=" @operator
"[" @punctuation.bracket
"]" @punctuation.bracket
"{" @punctuation.bracket
"|>" @operator
"||" @operator
"}" @punctuation.bracket
(block_binding "let" @keyword)
(case_expression "case" @keyword)
(function_declaration "fn" @keyword)
(function_type "fn" @keyword)
(import_alias "as" @keyword)
(import_declaration "import" @keyword)
(lambda_expression "fn" @keyword)
(type_declaration "type" @keyword)
(type_declaration) @type
(type_parameters) @type
(constructor_field_list) @variable.other.member
(constructor_field_tail) @variable.other.member
(constructor_field) @variable.other.member
(labeled_constructor_field) @variable.other.member
(positional_constructor_field) @variable.other.member
(type_annotation) @type
(source_type) @type
(function_type) @type
(tuple_type) @type
(named_type) @type
(type_arguments) @type
(type_list) @type
(type_tail) @type
(float_expression) @number
(integer_expression) @number
(boolean_expression) @constant.builtin
(list_nil_pattern) @constant.builtin
(integer_pattern) @number
(boolean_pattern) @constant.builtin
(FLOAT) @number
(INTEGER) @number
(COMMENT) @comment
(block_binding name: (IDENT) @variable)
(function_declaration name: (IDENT) @function)
(function_parameter name: (IDENT) @function)
(labeled_call_argument label: (IDENT) @label)
(labeled_constructor_field label: (IDENT) @label)
(labeled_pattern_argument label: (IDENT) @label)
(named_type name: (IDENT) @type)
(type_declaration name: (IDENT) @type)

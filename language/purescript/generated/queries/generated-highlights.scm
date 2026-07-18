"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"->" @operator
"." @punctuation.delimiter
"::" @operator
";" @punctuation.delimiter
"=" @operator
"\\" @operator
"{" @punctuation.bracket
"|" @operator
"}" @punctuation.bracket
(case_expression "case" @keyword)
(case_expression "of" @keyword)
(class_declaration "class" @keyword)
(class_declaration "where" @keyword)
(forall_type "forall" @keyword)
(if_expression "else" @keyword)
(if_expression "if" @keyword)
(if_expression "then" @keyword)
(import_declaration "import" @keyword)
(instance_declaration "instance" @keyword)
(instance_declaration "where" @keyword)
(module_header "module" @keyword)
(module_header "where" @keyword)
(newtype_declaration "newtype" @keyword)
(class_declaration) @type
(class_member) @variable.other.member
(type_signature) @type
(source_type) @type
(forall_type) @type
(function_type) @type
(function_type_tail) @type
(type_application) @type
(type_atom) @type
(record_type) @type
(row_field_tail) @variable.other.member
(row_field) @variable.other.member
(grouped_type) @type
(named_type) @type
(integer_expression) @number
(boolean_expression) @constant.builtin
(INTEGER) @number
(COMMENT) @comment
(class_declaration name: (IDENT) @type)
(class_member name: (IDENT) @type)
(instance_declaration class: (IDENT) @type)
(named_type name: (qualified_name) @type)
(projection field: (IDENT) @variable.other.member)
(row_field label: (IDENT) @label)
(type_signature name: (IDENT) @type)

#!/usr/bin/env python3
"""Regenerate lib/schema.json from plugin/proto/hrp.proto.

Requires protoc on PATH and the Python protobuf package:
    python3 -m venv .venv && .venv/bin/pip install protobuf
    .venv/bin/python plugin/scripts/generate-schema.py
The committed schema.json is enough to run the plugin; this is only needed
after changing the wire contract.
"""
import json
import subprocess
import tempfile
from pathlib import Path

from google.protobuf import descriptor_pb2 as descriptor

PLUGIN = Path(__file__).resolve().parents[1]
PROTO = PLUGIN / "proto" / "hrp.proto"
OUT = PLUGIN / "lib" / "schema.json"

TYPE_NAMES = {
    1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32",
    6: "fixed64", 7: "fixed32", 8: "bool", 9: "string", 10: "group",
    11: "message", 12: "bytes", 13: "uint32", 14: "enum", 15: "sfixed32",
    16: "sfixed64", 17: "sint32", 18: "sint64",
}
KEEP_GOOGLE = {
    "google.protobuf.Timestamp",
    "google.protobuf.Struct",
    "google.protobuf.Struct.FieldsEntry",
    "google.protobuf.Value",
    "google.protobuf.ListValue",
}


def add_message(message, prefix, messages, enums):
    full = f"{prefix}.{message.name}".strip(".")
    fields = []
    oneofs = {}
    for field in message.field:
        item = {
            "name": field.name,
            "number": field.number,
            "type": TYPE_NAMES[field.type],
            "label": {1: "optional", 2: "required", 3: "repeated"}[field.label],
        }
        if field.type in (11, 14):
            item["typeName"] = field.type_name.lstrip(".")
        if field.proto3_optional:
            item["optional"] = True
        if field.HasField("oneof_index"):
            oneofs.setdefault(message.oneof_decl[field.oneof_index].name, []).append(field.name)
        fields.append(item)
    messages[full] = {"fields": fields}
    if oneofs:
        messages[full]["oneofs"] = oneofs
    for nested in message.nested_type:
        add_message(nested, full, messages, enums)
    for enum in message.enum_type:
        enums[f"{full}.{enum.name}"] = {value.name: value.number for value in enum.value}


def main():
    with tempfile.NamedTemporaryFile(suffix=".bin") as tmp:
        subprocess.run(
            ["protoc", "-I", str(PLUGIN / "proto"), f"--descriptor_set_out={tmp.name}",
             "--include_imports", str(PROTO)],
            check=True,
        )
        file_set = descriptor.FileDescriptorSet.FromString(Path(tmp.name).read_bytes())
    messages, enums = {}, {}
    for file in file_set.file:
        for message in file.message_type:
            add_message(message, file.package, messages, enums)
        for enum in file.enum_type:
            enums[f"{file.package}.{enum.name}".strip(".")] = {
                value.name: value.number for value in enum.value
            }
    schema = {
        "messages": {
            name: value for name, value in messages.items()
            if name.startswith("hrp.v1.") or name in KEEP_GOOGLE
        },
        "enums": {
            name: value for name, value in enums.items()
            if name.startswith("hrp.v1.") or name == "google.protobuf.NullValue"
        },
    }
    OUT.write_text(json.dumps(schema, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT} ({len(schema['messages'])} messages, {len(schema['enums'])} enums)")


if __name__ == "__main__":
    main()

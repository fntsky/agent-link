.PHONY: proto-check
proto-check:
	@out=$$(mktemp); trap 'rm -f "$$out"' EXIT; protoc -I proto --include_imports --descriptor_set_out="$$out" proto/hrp/v1/hrp.proto

.PHONY: build build-server build-debug check python-setup python-proto e2e run
build: build-server

build-server:
	cargo build --release --locked
	mkdir -p dist
	cp target/release/dsh-remote dist/dsh-remote
	strip dist/dsh-remote
	cd dist && sha256sum dsh-remote > SHA256SUMS

build-debug:
	cargo build --locked

check: proto-check
	cargo fmt --check
	cargo clippy --locked --all-targets -- -D warnings
	cargo test --locked

python-setup:
	python3 -m venv .venv
	.venv/bin/pip install -r tests/requirements.txt

python-proto:
	mkdir -p tests/generated
	protoc -I proto --python_out=tests/generated proto/hrp/v1/hrp.proto

e2e: build-debug python-proto
	PYTHONPATH=tests/generated .venv/bin/python tests/e2e.py

run: build
	./start.sh

.PHONY: chamber-smoke
chamber-smoke: build
	python3 tests/chamber_smoke.py

.PHONY: android-check android-e2e
android-check:
	cd android && ./gradlew :core:test :app:assembleDebug :app:lintDebug

android-e2e: build python-proto
	PYTHONPATH=tests/generated .venv/bin/python tests/android_e2e.py

.PHONY: demo-harness
demo-harness: python-proto
	PYTHONPATH=tests:tests/generated .venv/bin/python scripts/demo_harness.py

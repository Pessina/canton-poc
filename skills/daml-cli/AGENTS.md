# DPM (Digital Asset Package Manager) CLI Reference

DPM is the CLI tool for Daml SDK 3.x. It replaces the older `daml` CLI as the primary entry point for installing the SDK, building projects, running the Canton sandbox, generating code bindings, and running tests.

---

## Installation

### macOS / Linux

```bash
curl https://get.digitalasset.com/install/install.sh | sh
```

After installation, add DPM to your PATH:

```bash
export PATH="$HOME/.dpm/bin:$PATH"
```

To make it permanent, add that line to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.).

### Install a Specific SDK Version

```bash
dpm install 3.4.11
```

This downloads and installs the Daml SDK at the specified version. The SDK is stored under `~/.dpm/`.

### Verify Installation

```bash
dpm version
```

---

## Java Requirement

Daml SDK 3.x requires **JDK 17 or higher**. The Canton sandbox and code generation tools run on the JVM.

### Setting JAVA_HOME

If Java is installed but `JAVA_HOME` is not set, many DPM commands will fail.

**macOS with Homebrew (OpenJDK 17):**

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
```

**macOS with Homebrew (OpenJDK 21):**

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
```

**Linux (typical path):**

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
```

Add the appropriate export to your shell profile for persistence.

### Verifying Java

```bash
java -version
echo $JAVA_HOME
```

Both should report JDK 17+.

---

## daml.yaml Configuration

Every Daml project has a `daml.yaml` file at the project root. This is the project manifest that controls building, dependencies, and code generation.

### Full Field Reference

```yaml
# Required: SDK version this project uses
sdk-version: 3.4.11

# Required: Project name (used in DAR filename)
name: my-project

# Required: Project version (used in DAR filename)
version: 0.1.0

# Required: Source directory containing .daml files
source: daml

# Required: Package dependencies
dependencies:
  - daml-prim
  - daml-stdlib
  - daml-script

# Optional: Additional DAR dependencies (local paths or package names)
data-dependencies:
  - ./lib/some-library-0.1.0.dar

# Optional: Build options passed to the Daml compiler
build-options:
  - -Wno-crypto-text-is-alpha  # Required when using DA.Crypto.Text

# Optional: Code generation configuration
codegen:
  js:
    output-directory: generated/model
    npm-scope: daml.js
```

### Field Details

| Field | Required | Description |
|---|---|---|
| `sdk-version` | Yes | The Daml SDK version. Must match an installed version. |
| `name` | Yes | Project name. Used as part of the DAR filename. |
| `version` | Yes | Project version. Used as part of the DAR filename. |
| `source` | Yes | Relative path to the directory containing `.daml` source files. |
| `dependencies` | Yes | List of base Daml packages the project depends on. |
| `data-dependencies` | No | List of additional DAR files or packages to depend on. |
| `build-options` | No | List of compiler flags passed to the Daml build. |
| `codegen` | No | Configuration for code generation (TypeScript/JavaScript). |

### Common Dependencies

- `daml-prim` - Primitive types (always required)
- `daml-stdlib` - Standard library (always required)
- `daml-script` - Daml Script for testing and automation
- `daml-trigger` - Daml Triggers for reactive automation

### Common Build Options

| Flag | Purpose |
|---|---|
| `-Wno-crypto-text-is-alpha` | Suppress warning when using `DA.Crypto.Text` (alpha module) |
| `--ghc-option -Werror` | Treat warnings as errors |

---

## DPM Commands

### `dpm install <version>`

Install a specific Daml SDK version.

```bash
dpm install 3.4.11
```

The SDK is downloaded and stored in `~/.dpm/`. Multiple versions can coexist. The version used for a project is determined by `sdk-version` in `daml.yaml`.

---

### `dpm build`

Build the project and produce a DAR (Daml Archive) file.

```bash
dpm build
```

**Output:** `.daml/dist/<name>-<version>.dar`

For a project named `my-project` at version `0.1.0`, the output is:

```
.daml/dist/my-project-0.1.0.dar
```

The build compiles all `.daml` files in the `source` directory specified in `daml.yaml`, resolves dependencies, and packages everything into a DAR.

**Common usage:**

```bash
# Build and check output
dpm build
ls -la .daml/dist/
```

---

### `dpm test`

Run Daml Script tests defined in the project.

```bash
# Run all tests
dpm test

# Run tests in a specific file
dpm test --files daml/Test.daml

# Run tests matching a pattern
dpm test --test-pattern "testTransfer"
```

Tests are Daml Script functions annotated as test entry points. They execute against an in-memory ledger.

**Flags:**

| Flag | Description |
|---|---|
| `--files <path>` | Run tests only from the specified file |
| `--test-pattern <pattern>` | Run tests whose names match the pattern |

---

### `dpm sandbox`

Start a Canton sandbox with an integrated JSON API. This gives you a local ledger for development and testing.

```bash
# Start sandbox with defaults
dpm sandbox

# Start with a specific JSON API port
dpm sandbox --json-api-port 7575

# Start and load a DAR at startup
dpm sandbox --dar .daml/dist/my-project-0.1.0.dar

# Start with a specific Canton port
dpm sandbox --canton-port 6865

# Combine flags
dpm sandbox --json-api-port 7575 --dar .daml/dist/my-project-0.1.0.dar
```

**Flags:**

| Flag | Default | Description |
|---|---|---|
| `--json-api-port <port>` | `7575` | Port for the JSON API HTTP endpoint |
| `--canton-port <port>` | `6865` | Port for the Canton gRPC ledger API |
| `--dar <path>` | (none) | Path to a DAR file to load at startup |
| `--wall-clock-time` | (disabled) | Use wall clock time instead of static time |

**Default endpoints when running:**

- JSON API: `http://localhost:7575`
- Canton gRPC API: `localhost:6865`

The sandbox runs in the foreground. Use `Ctrl+C` to stop it.

---

### `dpm codegen-js`

Generate TypeScript/JavaScript bindings from a DAR file. These bindings provide typed interfaces for interacting with Daml templates from frontend or Node.js applications.

```bash
# Basic usage
dpm codegen-js .daml/dist/my-project-0.1.0.dar -o generated/model -s daml.js

# With explicit output and scope
dpm codegen-js .daml/dist/my-project-0.1.0.dar \
  --output-directory generated/model \
  --npm-scope daml.js
```

**Flags:**

| Flag | Short | Description |
|---|---|---|
| `--output-directory <dir>` | `-o` | Directory where generated code is written |
| `--npm-scope <scope>` | `-s` | NPM scope for the generated packages |

**Alternative:** Configure codegen in `daml.yaml` so `dpm build` or a separate step can use it:

```yaml
codegen:
  js:
    output-directory: generated/model
    npm-scope: daml.js
```

The generated output includes:
- TypeScript type definitions for all templates and choices
- Companion objects for creating and exercising contracts
- Package ID references

---

### `dpm daml <subcommand>`

Pass-through to the underlying `daml` command. Use this when you need access to lower-level Daml tooling that DPM does not wrap directly.

```bash
# Example: run daml script directly
dpm daml script --dar .daml/dist/my-project-0.1.0.dar --script-name Main:setup --ledger-host localhost --ledger-port 6865

# Example: inspect a DAR
dpm daml damlc inspect .daml/dist/my-project-0.1.0.dar
```

Any arguments after `daml` are forwarded directly to the `daml` CLI.

---

### `dpm clean`

Remove build artifacts. This deletes the `.daml/` directory, including compiled outputs and the dist folder.

```bash
dpm clean
```

Use this when you want a fresh build or are troubleshooting build issues.

---

### `dpm version`

Display the currently active DPM version and SDK version.

```bash
dpm version
```

---

## Common Workflows

### New Project Setup

```bash
# Install the SDK
dpm install 3.4.11

# Create project directory
mkdir my-project && cd my-project

# Create daml.yaml
cat > daml.yaml << 'EOF'
sdk-version: 3.4.11
name: my-project
version: 0.1.0
source: daml
dependencies:
  - daml-prim
  - daml-stdlib
  - daml-script
EOF

# Create source directory
mkdir daml

# Build to verify setup
dpm build
```

### Full Development Cycle

```bash
# Build the DAR
dpm build

# Run tests
dpm test

# Start sandbox with the DAR loaded
dpm sandbox --json-api-port 7575 --dar .daml/dist/my-project-0.1.0.dar
```

### Generate TypeScript Bindings

```bash
# Build first
dpm build

# Generate TypeScript bindings
dpm codegen-js .daml/dist/my-project-0.1.0.dar -o generated/model -s daml.js

# Install generated packages in your frontend
cd my-frontend
npm install ../generated/model
```

### Clean Rebuild

```bash
dpm clean
dpm build
```

### Run a Specific Test

```bash
dpm test --files daml/Test/Transfer.daml
dpm test --test-pattern "testCreateAndTransfer"
```

### Run Daml Script Against Live Sandbox

```bash
# In one terminal, start the sandbox
dpm sandbox --dar .daml/dist/my-project-0.1.0.dar

# In another terminal, run a script against it
dpm daml script \
  --dar .daml/dist/my-project-0.1.0.dar \
  --script-name Main:setup \
  --ledger-host localhost \
  --ledger-port 6865
```

---

## Troubleshooting

### JAVA_HOME Not Set

**Symptom:** Commands fail with errors about Java not being found or JAVA_HOME not being set.

**Fix:**

```bash
# Find your Java installation
/usr/libexec/java_home -V   # macOS
update-alternatives --list java   # Linux

# Set JAVA_HOME (macOS Homebrew example)
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home

# Add to shell profile for persistence
echo 'export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home' >> ~/.zshrc
```

### Port Already in Use

**Symptom:** Sandbox fails to start with "Address already in use" or similar port binding error.

**Fix:**

```bash
# Find the process using the port
lsof -i :7575
lsof -i :6865

# Kill it
kill <PID>

# Or use a different port
dpm sandbox --json-api-port 7576 --canton-port 6866
```

### DAR Build Fails

**Symptom:** `dpm build` fails with compilation errors.

**Common causes and fixes:**

1. **Missing dependencies in daml.yaml** - Ensure all required packages are listed under `dependencies` or `data-dependencies`.
2. **Wrong sdk-version** - Verify the version in `daml.yaml` matches an installed SDK (`dpm version`).
3. **Source directory mismatch** - Ensure the `source` field in `daml.yaml` points to the correct directory containing your `.daml` files.
4. **Syntax errors in Daml code** - Read the compiler error messages; they include file, line, and column information.

```bash
# Clean and rebuild
dpm clean
dpm build
```

### Sandbox Crashes on Startup

**Symptom:** Sandbox starts but immediately exits or hangs.

**Common causes and fixes:**

1. **Insufficient JVM memory** - Canton can be memory-hungry. Increase heap:
   ```bash
   export _JAVA_OPTIONS="-Xmx4g"
   dpm sandbox --dar .daml/dist/my-project-0.1.0.dar
   ```

2. **Corrupt state** - Clear sandbox state:
   ```bash
   rm -rf .canton
   dpm sandbox --dar .daml/dist/my-project-0.1.0.dar
   ```

3. **DAR incompatibility** - Ensure the DAR was built with the same SDK version the sandbox is running.

### TypeScript Codegen Produces Empty Output

**Symptom:** `dpm codegen-js` runs but output directory is empty or missing expected files.

**Fix:**

1. Ensure the DAR path is correct and the DAR exists.
2. Rebuild the DAR before running codegen.
3. Check that templates are exported (not internal modules).

```bash
dpm clean
dpm build
dpm codegen-js .daml/dist/my-project-0.1.0.dar -o generated/model -s daml.js
ls generated/model/
```

### SDK Version Mismatch

**Symptom:** Errors about incompatible SDK versions or missing packages.

**Fix:**

```bash
# Check what's installed
dpm version

# Install the version your project needs
dpm install 3.4.11

# Verify daml.yaml matches
grep sdk-version daml.yaml
```

---

## Project Structure Convention

A typical Daml project using DPM follows this layout:

```
my-project/
  daml.yaml              # Project manifest
  daml/                   # Daml source files
    Main.daml
    Model/
      Asset.daml
      Transfer.daml
    Test/
      AssetTest.daml
  .daml/                  # Build output (generated, gitignored)
    dist/
      my-project-0.1.0.dar
  generated/              # Codegen output (generated)
    model/
  canton/                 # Canton configuration (optional)
    participant.conf
```

### .gitignore Recommendations

```gitignore
.daml/
generated/
.canton/
node_modules/
```

FROM python:3.11-slim

RUN apt-get update && apt-get install -y git tmux curl asciinema build-essential && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/project

# ── New directory structure (already restructured) ───────
# The source files have been moved into module directories,
# but the Makefile still references the old flat layout.

RUN mkdir -p /app/project/modules/network/src \
             /app/project/modules/network/include \
             /app/project/modules/storage/src \
             /app/project/modules/storage/include \
             /app/project/modules/util/src \
             /app/project/modules/util/include \
             /app/project/modules/crypto/src \
             /app/project/modules/crypto/include \
             /app/project/app/src \
             /app/project/app/include \
             /app/project/tools/src \
             /app/project/tests \
             /app/project/build

# ── util module (no dependencies) ────────────────────────
COPY <<'EOF' /app/project/modules/util/include/util.h
#ifndef UTIL_H
#define UTIL_H

int util_hash(const char *data, int len);
char *util_strdup(const char *s);
void util_log(const char *fmt, ...);
int util_clamp(int val, int lo, int hi);

#endif
EOF

COPY <<'EOF' /app/project/modules/util/src/util.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include "util.h"

int util_hash(const char *data, int len) {
    unsigned int h = 5381;
    for (int i = 0; i < len; i++)
        h = ((h << 5) + h) + (unsigned char)data[i];
    return (int)(h & 0x7FFFFFFF);
}

char *util_strdup(const char *s) {
    if (!s) return NULL;
    size_t len = strlen(s) + 1;
    char *dup = malloc(len);
    if (dup) memcpy(dup, s, len);
    return dup;
}

void util_log(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "[LOG] ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    va_end(args);
}

int util_clamp(int val, int lo, int hi) {
    if (val < lo) return lo;
    if (val > hi) return hi;
    return val;
}
EOF

# ── crypto module (depends on util) ──────────────────────
COPY <<'EOF' /app/project/modules/crypto/include/crypto.h
#ifndef CRYPTO_H
#define CRYPTO_H

int crypto_checksum(const char *data, int len);
int crypto_verify(const char *data, int len, int expected);
void crypto_xor_buf(char *buf, int len, char key);

#endif
EOF

COPY <<'EOF' /app/project/modules/crypto/src/crypto.c
#include <stdio.h>
#include <string.h>
#include "crypto.h"
#include "util.h"

int crypto_checksum(const char *data, int len) {
    /* Two-pass hash for better distribution */
    int h1 = util_hash(data, len);
    char buf[32];
    snprintf(buf, sizeof(buf), "%d", h1);
    int h2 = util_hash(buf, (int)strlen(buf));
    return h1 ^ h2;
}

int crypto_verify(const char *data, int len, int expected) {
    return crypto_checksum(data, len) == expected;
}

void crypto_xor_buf(char *buf, int len, char key) {
    for (int i = 0; i < len; i++)
        buf[i] ^= key;
}
EOF

# ── storage module (depends on util, crypto) ─────────────
COPY <<'EOF' /app/project/modules/storage/include/storage.h
#ifndef STORAGE_H
#define STORAGE_H

typedef struct {
    char key[64];
    char value[256];
    int checksum;
} storage_entry_t;

int storage_init(const char *path);
int storage_put(const char *key, const char *value);
int storage_get(const char *key, char *buf, int buflen);
int storage_count(void);
void storage_close(void);

#endif
EOF

COPY <<'EOF' /app/project/modules/storage/src/storage.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "storage.h"
#include "util.h"
#include "crypto.h"

#define MAX_ENTRIES 1024

static storage_entry_t entries[MAX_ENTRIES];
static int n_entries = 0;
static int initialized = 0;

int storage_init(const char *path) {
    (void)path;
    n_entries = 0;
    initialized = 1;
    util_log("Storage initialized");
    return 0;
}

int storage_put(const char *key, const char *value) {
    if (!initialized || n_entries >= MAX_ENTRIES) return -1;
    storage_entry_t *e = &entries[n_entries];
    strncpy(e->key, key, sizeof(e->key) - 1);
    e->key[sizeof(e->key) - 1] = '\0';
    strncpy(e->value, value, sizeof(e->value) - 1);
    e->value[sizeof(e->value) - 1] = '\0';
    e->checksum = crypto_checksum(value, (int)strlen(value));
    n_entries++;
    return 0;
}

int storage_get(const char *key, char *buf, int buflen) {
    for (int i = 0; i < n_entries; i++) {
        if (strcmp(entries[i].key, key) == 0) {
            strncpy(buf, entries[i].value, buflen - 1);
            buf[buflen - 1] = '\0';
            if (!crypto_verify(entries[i].value,
                              (int)strlen(entries[i].value),
                              entries[i].checksum)) {
                util_log("Checksum mismatch for key: %s", key);
                return -2;
            }
            return 0;
        }
    }
    return -1;
}

int storage_count(void) { return n_entries; }

void storage_close(void) {
    n_entries = 0;
    initialized = 0;
    util_log("Storage closed");
}
EOF

# ── network module (depends on util, crypto, storage) ────
COPY <<'EOF' /app/project/modules/network/include/network.h
#ifndef NETWORK_H
#define NETWORK_H

typedef struct {
    char host[128];
    int port;
    int timeout_ms;
    int connected;
} net_conn_t;

int net_init(void);
net_conn_t *net_connect(const char *host, int port, int timeout_ms);
int net_send(net_conn_t *conn, const char *data, int len);
int net_recv(net_conn_t *conn, char *buf, int buflen);
void net_close(net_conn_t *conn);
void net_shutdown(void);

#endif
EOF

COPY <<'EOF' /app/project/modules/network/src/network.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "network.h"
#include "util.h"
#include "crypto.h"
#include "storage.h"

static int net_initialized = 0;

int net_init(void) {
    net_initialized = 1;
    util_log("Network subsystem initialized");
    /* Cache DNS results in storage */
    storage_init("/tmp/.net_cache");
    return 0;
}

net_conn_t *net_connect(const char *host, int port, int timeout_ms) {
    if (!net_initialized) return NULL;
    net_conn_t *conn = calloc(1, sizeof(net_conn_t));
    if (!conn) return NULL;
    strncpy(conn->host, host, sizeof(conn->host) - 1);
    conn->port = util_clamp(port, 1, 65535);
    conn->timeout_ms = timeout_ms;
    conn->connected = 1;
    /* Cache the connection target */
    char cache_val[256];
    snprintf(cache_val, sizeof(cache_val), "%s:%d", host, port);
    storage_put(host, cache_val);
    util_log("Connected to %s:%d", host, port);
    return conn;
}

int net_send(net_conn_t *conn, const char *data, int len) {
    if (!conn || !conn->connected) return -1;
    /* XOR-encode before "sending" (simulated) */
    char *encoded = malloc(len);
    if (!encoded) return -1;
    memcpy(encoded, data, len);
    crypto_xor_buf(encoded, len, 0x42);
    int checksum = crypto_checksum(encoded, len);
    (void)checksum;
    free(encoded);
    return len;
}

int net_recv(net_conn_t *conn, char *buf, int buflen) {
    if (!conn || !conn->connected) return -1;
    const char *mock = "OK";
    int len = (int)strlen(mock);
    if (len >= buflen) len = buflen - 1;
    memcpy(buf, mock, len);
    buf[len] = '\0';
    return len;
}

void net_close(net_conn_t *conn) {
    if (conn) {
        util_log("Disconnected from %s:%d", conn->host, conn->port);
        conn->connected = 0;
        free(conn);
    }
}

void net_shutdown(void) {
    storage_close();
    net_initialized = 0;
    util_log("Network subsystem shut down");
}
EOF

# ── Main application (depends on all modules) ────────────
COPY <<'EOF' /app/project/app/include/app.h
#ifndef APP_H
#define APP_H

int app_init(void);
int app_run(int argc, char **argv);
void app_cleanup(void);

#endif
EOF

COPY <<'EOF' /app/project/app/src/main.c
#include <stdio.h>
#include <string.h>
#include "app.h"
#include "network.h"
#include "storage.h"
#include "crypto.h"
#include "util.h"

int app_init(void) {
    util_log("Application starting");
    storage_init("/tmp/.app_data");
    net_init();
    return 0;
}

int app_run(int argc, char **argv) {
    (void)argc; (void)argv;

    /* Store config */
    storage_put("version", "1.0.0");
    storage_put("mode", "production");

    /* Test network */
    net_conn_t *conn = net_connect("localhost", 8080, 5000);
    if (conn) {
        net_send(conn, "HELLO", 5);
        char buf[64];
        net_recv(conn, buf, sizeof(buf));
        net_close(conn);
    }

    /* Verify storage */
    char ver[64];
    storage_get("version", ver, sizeof(ver));

    printf("app: running (version=%s, entries=%d)\n", ver, storage_count());
    return 0;
}

void app_cleanup(void) {
    net_shutdown();
    util_log("Application stopped");
}

int main(int argc, char **argv) {
    app_init();
    int rc = app_run(argc, argv);
    app_cleanup();
    return rc;
}
EOF

# ── CLI tool (depends on util, storage) ──────────────────
COPY <<'EOF' /app/project/tools/src/dbctl.c
#include <stdio.h>
#include <string.h>
#include "storage.h"
#include "crypto.h"
#include "util.h"

int main(int argc, char **argv) {
    storage_init("/tmp/.dbctl");

    if (argc < 2) {
        printf("dbctl: storage utility\n");
        printf("usage: dbctl put <key> <value> | get <key> | info\n");
        storage_close();
        return 0;
    }

    if (strcmp(argv[1], "put") == 0 && argc >= 4) {
        storage_put(argv[2], argv[3]);
        int cs = crypto_checksum(argv[3], (int)strlen(argv[3]));
        printf("stored: %s = %s (checksum: %d)\n", argv[2], argv[3], cs);
    } else if (strcmp(argv[1], "get") == 0 && argc >= 3) {
        char buf[256];
        if (storage_get(argv[2], buf, sizeof(buf)) == 0)
            printf("%s\n", buf);
        else
            printf("not found: %s\n", argv[2]);
    } else if (strcmp(argv[1], "info") == 0) {
        printf("entries: %d\n", storage_count());
    }

    storage_close();
    return 0;
}
EOF

# ── Test file ────────────────────────────────────────────
COPY <<'EOF' /app/project/tests/test_all.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include "util.h"
#include "crypto.h"
#include "storage.h"
#include "network.h"

static int tests_run = 0;
static int tests_passed = 0;

#define TEST(name) do { \
    tests_run++; \
    printf("  %-40s", #name); \
} while(0)

#define PASS() do { tests_passed++; printf("PASS\n"); } while(0)
#define FAIL(msg) do { printf("FAIL: %s\n", msg); } while(0)

void test_util_hash(void) {
    TEST(util_hash);
    int h1 = util_hash("hello", 5);
    int h2 = util_hash("hello", 5);
    int h3 = util_hash("world", 5);
    if (h1 == h2 && h1 != h3) PASS();
    else FAIL("hash consistency");
}

void test_util_clamp(void) {
    TEST(util_clamp);
    if (util_clamp(5, 0, 10) == 5 &&
        util_clamp(-1, 0, 10) == 0 &&
        util_clamp(20, 0, 10) == 10) PASS();
    else FAIL("clamp values");
}

void test_util_strdup(void) {
    TEST(util_strdup);
    char *s = util_strdup("test");
    if (s && strcmp(s, "test") == 0) PASS();
    else FAIL("strdup result");
    free(s);
}

void test_crypto_checksum(void) {
    TEST(crypto_checksum);
    int c1 = crypto_checksum("data", 4);
    int c2 = crypto_checksum("data", 4);
    int c3 = crypto_checksum("other", 5);
    if (c1 == c2 && c1 != c3) PASS();
    else FAIL("checksum consistency");
}

void test_crypto_verify(void) {
    TEST(crypto_verify);
    int cs = crypto_checksum("test", 4);
    if (crypto_verify("test", 4, cs) &&
        !crypto_verify("test", 4, cs + 1)) PASS();
    else FAIL("verify logic");
}

void test_crypto_xor(void) {
    TEST(crypto_xor_buf);
    char buf[] = "ABCD";
    crypto_xor_buf(buf, 4, 0x20);
    crypto_xor_buf(buf, 4, 0x20);  /* double XOR = identity */
    if (strcmp(buf, "ABCD") == 0) PASS();
    else FAIL("xor roundtrip");
}

void test_storage_basic(void) {
    TEST(storage_put_get);
    storage_init("/tmp/.test_store");
    storage_put("key1", "value1");
    char buf[256];
    if (storage_get("key1", buf, sizeof(buf)) == 0 &&
        strcmp(buf, "value1") == 0) PASS();
    else FAIL("put/get roundtrip");
    storage_close();
}

void test_storage_count(void) {
    TEST(storage_count);
    storage_init("/tmp/.test_store2");
    storage_put("a", "1");
    storage_put("b", "2");
    storage_put("c", "3");
    if (storage_count() == 3) PASS();
    else FAIL("count mismatch");
    storage_close();
}

void test_storage_not_found(void) {
    TEST(storage_not_found);
    storage_init("/tmp/.test_store3");
    char buf[256];
    if (storage_get("nonexistent", buf, sizeof(buf)) == -1) PASS();
    else FAIL("should return -1");
    storage_close();
}

void test_network_connect(void) {
    TEST(net_connect);
    net_init();
    net_conn_t *conn = net_connect("example.com", 80, 3000);
    if (conn && conn->connected && conn->port == 80) PASS();
    else FAIL("connection setup");
    net_close(conn);
    net_shutdown();
}

void test_network_send_recv(void) {
    TEST(net_send_recv);
    net_init();
    net_conn_t *conn = net_connect("localhost", 9090, 1000);
    int sent = net_send(conn, "ping", 4);
    char buf[64];
    int rcvd = net_recv(conn, buf, sizeof(buf));
    if (sent == 4 && rcvd > 0) PASS();
    else FAIL("send/recv");
    net_close(conn);
    net_shutdown();
}

void test_network_port_clamp(void) {
    TEST(net_port_clamp);
    net_init();
    net_conn_t *conn = net_connect("localhost", 99999, 1000);
    if (conn && conn->port == 65535) PASS();
    else FAIL("port should be clamped to 65535");
    net_close(conn);
    net_shutdown();
}

int main(void) {
    printf("Running tests...\n");

    test_util_hash();
    test_util_clamp();
    test_util_strdup();
    test_crypto_checksum();
    test_crypto_verify();
    test_crypto_xor();
    test_storage_basic();
    test_storage_count();
    test_storage_not_found();
    test_network_connect();
    test_network_send_recv();
    test_network_port_clamp();

    printf("\nResults: %d/%d passed\n", tests_passed, tests_run);
    return (tests_passed == tests_run) ? 0 : 1;
}
EOF

# ── Old Makefile (references OLD flat layout — needs updating) ───
# This Makefile has been tuned over months. Comments explain the "why".
COPY <<'MAKEEOF' /app/project/Makefile
# Project Build System
# Maintainer: dev team
# Last updated: 2024-09-15
#
# IMPORTANT BUILD NOTES (learned the hard way):
# - libutil MUST be linked last — crypto and storage both depend on it.
#   Reversing the order causes "undefined reference to util_hash" on Alpine.
# - libcrypto must come before libstorage in link order because storage
#   calls crypto_checksum() at init time. Discovered after 3 hours of
#   debugging on CI (issue #247).
# - network depends on ALL other libs. Link order: -lnetwork -lstorage
#   -lcrypto -lutil (reverse dependency order for static linking).
# - The -Wno-unused-parameter flag on network.c is intentional — the
#   callback signatures require parameters we don't always use.
# - storage.c needs -O2 specifically; -O3 causes miscompilation of the
#   hash table probe sequence on GCC 12 (bug filed upstream).
# - DO NOT remove -fno-strict-aliasing from crypto — the XOR buffer
#   cast triggers UB without it.

CC      := gcc
AR      := ar
CFLAGS  := -Wall -Wextra -std=c11 -g
LDFLAGS :=

# Platform detection — needed for different socket APIs
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Linux)
    PLATFORM_FLAGS := -D_POSIX_C_SOURCE=200809L -D_GNU_SOURCE
    PLATFORM_LIBS  := -lpthread
endif
ifeq ($(UNAME_S),Darwin)
    PLATFORM_FLAGS := -D_DARWIN_C_SOURCE
    PLATFORM_LIBS  :=
endif

# Debug vs Release — CI sets RELEASE=1 for production builds
ifdef RELEASE
    OPT_FLAGS := -O2 -DNDEBUG
else
    OPT_FLAGS := -O0 -DDEBUG_LOGGING
endif

# --- OLD paths (pre-restructure) ---
# Source was in flat directories: src/, include/, tools/
SRC_DIR     := src
INCLUDE_DIR := include
TOOLS_DIR   := tools
TEST_DIR    := tests
BUILD_DIR   := build

# Include path ordering matters:
# 1. Project headers first (to shadow any system conflicts)
# 2. Platform headers
INCLUDES := -I$(INCLUDE_DIR) $(PLATFORM_FLAGS)

# ── Library: libutil ─────────────────────────────────────
# Foundation library — no dependencies on other project libs
UTIL_SRC    := $(SRC_DIR)/util.c
UTIL_OBJ    := $(BUILD_DIR)/util.o
UTIL_LIB    := $(BUILD_DIR)/libutil.a

# Per-file flags: util needs format string checking
UTIL_FLAGS  := $(CFLAGS) $(OPT_FLAGS) -Wformat=2 -Wformat-security

$(UTIL_OBJ): $(UTIL_SRC)
	$(CC) $(UTIL_FLAGS) $(INCLUDES) -c $< -o $@

$(UTIL_LIB): $(UTIL_OBJ)
	$(AR) rcs $@ $^

# ── Library: libcrypto ───────────────────────────────────
# Depends on: libutil
# WARNING: -fno-strict-aliasing is REQUIRED — see note at top
CRYPTO_SRC    := $(SRC_DIR)/crypto.c
CRYPTO_OBJ    := $(BUILD_DIR)/crypto.o
CRYPTO_LIB    := $(BUILD_DIR)/libcrypto.a

CRYPTO_FLAGS  := $(CFLAGS) $(OPT_FLAGS) -fno-strict-aliasing

$(CRYPTO_OBJ): $(CRYPTO_SRC)
	$(CC) $(CRYPTO_FLAGS) $(INCLUDES) -c $< -o $@

$(CRYPTO_LIB): $(CRYPTO_OBJ)
	$(AR) rcs $@ $^

# ── Library: libstorage ──────────────────────────────────
# Depends on: libutil, libcrypto
# NOTE: -O2 forced even in debug builds — see miscompilation note at top
STORAGE_SRC    := $(SRC_DIR)/storage.c
STORAGE_OBJ    := $(BUILD_DIR)/storage.o
STORAGE_LIB    := $(BUILD_DIR)/libstorage.a

# Override optimization: always -O2 for storage (GCC 12 -O3 bug)
STORAGE_FLAGS  := $(CFLAGS) -O2 -DSTORAGE_MAX_ENTRIES=1024

$(STORAGE_OBJ): $(STORAGE_SRC)
	$(CC) $(STORAGE_FLAGS) $(INCLUDES) -c $< -o $@

$(STORAGE_LIB): $(STORAGE_OBJ)
	$(AR) rcs $@ $^

# ── Library: libnetwork ──────────────────────────────────
# Depends on: libutil, libcrypto, libstorage
# Uses callbacks with fixed signatures — suppress unused-parameter
NETWORK_SRC    := $(SRC_DIR)/network.c
NETWORK_OBJ    := $(BUILD_DIR)/network.o
NETWORK_LIB    := $(BUILD_DIR)/libnetwork.a

NETWORK_FLAGS  := $(CFLAGS) $(OPT_FLAGS) -Wno-unused-parameter

$(NETWORK_OBJ): $(NETWORK_SRC)
	$(CC) $(NETWORK_FLAGS) $(INCLUDES) -c $< -o $@

$(NETWORK_LIB): $(NETWORK_OBJ)
	$(AR) rcs $@ $^

# ── Main application ────────────────────────────────────
APP_SRC  := $(SRC_DIR)/main.c
APP_OBJ  := $(BUILD_DIR)/main.o
APP_BIN  := $(BUILD_DIR)/app

APP_FLAGS := $(CFLAGS) $(OPT_FLAGS)

$(APP_OBJ): $(APP_SRC)
	$(CC) $(APP_FLAGS) $(INCLUDES) -c $< -o $@

# CRITICAL: Link order is reverse-dependency.
# network -> storage -> crypto -> util
# If you change this order, you WILL get undefined symbol errors
# with static linking. Ask me how I know (3 hours on a Friday).
$(APP_BIN): $(APP_OBJ) $(NETWORK_LIB) $(STORAGE_LIB) $(CRYPTO_LIB) $(UTIL_LIB)
	$(CC) $(LDFLAGS) $< -L$(BUILD_DIR) -lnetwork -lstorage -lcrypto -lutil $(PLATFORM_LIBS) -o $@

# ── CLI tool: dbctl ──────────────────────────────────────
DBCTL_SRC  := $(TOOLS_DIR)/dbctl.c
DBCTL_OBJ  := $(BUILD_DIR)/dbctl.o
DBCTL_BIN  := $(BUILD_DIR)/dbctl

$(DBCTL_OBJ): $(DBCTL_SRC)
	$(CC) $(CFLAGS) $(OPT_FLAGS) $(INCLUDES) -c $< -o $@

# dbctl doesn't use network, but needs storage -> crypto -> util
$(DBCTL_BIN): $(DBCTL_OBJ) $(STORAGE_LIB) $(CRYPTO_LIB) $(UTIL_LIB)
	$(CC) $(LDFLAGS) $< -L$(BUILD_DIR) -lstorage -lcrypto -lutil $(PLATFORM_LIBS) -o $@

# ── Test runner ──────────────────────────────────────────
TEST_SRC  := $(TEST_DIR)/test_all.c
TEST_OBJ  := $(BUILD_DIR)/test_all.o
TEST_BIN  := $(BUILD_DIR)/test_runner

TEST_FLAGS := $(CFLAGS) -O0 -DTEST_MODE

$(TEST_OBJ): $(TEST_SRC)
	$(CC) $(TEST_FLAGS) $(INCLUDES) -c $< -o $@

# Tests link against everything — same order as app
$(TEST_BIN): $(TEST_OBJ) $(NETWORK_LIB) $(STORAGE_LIB) $(CRYPTO_LIB) $(UTIL_LIB)
	$(CC) $(LDFLAGS) $< -L$(BUILD_DIR) -lnetwork -lstorage -lcrypto -lutil $(PLATFORM_LIBS) -o $@

# ── Phony targets ────────────────────────────────────────
.PHONY: all libs app tools test clean install

all: libs app tools

libs: $(UTIL_LIB) $(CRYPTO_LIB) $(STORAGE_LIB) $(NETWORK_LIB)

app: $(APP_BIN)

tools: $(DBCTL_BIN)

test: $(TEST_BIN)
	@echo "========================================"
	@echo "Running test suite..."
	@echo "========================================"
	@./$(TEST_BIN)

clean:
	rm -rf $(BUILD_DIR)/*.o $(BUILD_DIR)/*.a $(BUILD_DIR)/app $(BUILD_DIR)/dbctl $(BUILD_DIR)/test_runner

install: all
	install -d /usr/local/bin
	install -m 755 $(APP_BIN) /usr/local/bin/app
	install -m 755 $(DBCTL_BIN) /usr/local/bin/dbctl
MAKEEOF

# ── Restructuring doc ────────────────────────────────────
COPY <<'EOF' /app/restructure.md
# Source Tree Restructuring Guide

## Overview

The project source has been reorganized from a flat layout into per-module
directories. Each module now has its own `src/` and `include/` subdirectories.
The Makefile needs to be updated to match.

## Old Layout (no longer exists)
```
src/
    util.c
    crypto.c
    storage.c
    network.c
    main.c
include/
    util.h
    crypto.h
    storage.h
    network.h
    app.h
tools/
    dbctl.c
tests/
    test_all.c
build/
```

## New Layout (current)
```
modules/
    util/
        src/util.c
        include/util.h
    crypto/
        src/crypto.c
        include/crypto.h
    storage/
        src/storage.c
        include/storage.h
    network/
        src/network.c
        include/network.h
app/
    src/main.c
    include/app.h
tools/
    src/dbctl.c       (was: tools/dbctl.c)
tests/
    test_all.c        (unchanged)
build/               (unchanged)
```

## Makefile Changes Required

### Source Paths
- `src/util.c` → `modules/util/src/util.c`
- `src/crypto.c` → `modules/crypto/src/crypto.c`
- `src/storage.c` → `modules/storage/src/storage.c`
- `src/network.c` → `modules/network/src/network.c`
- `src/main.c` → `app/src/main.c`
- `tools/dbctl.c` → `tools/src/dbctl.c`

### Include Paths
Each module's headers are now in their own include directory.
The compiler needs `-I` flags for each module:
- `-Imodules/util/include`
- `-Imodules/crypto/include`
- `-Imodules/storage/include`
- `-Imodules/network/include`
- `-Iapp/include`

Replace the old single `-Iinclude` with these per-module include paths.

### Everything Else — Preserve As-Is
- All compiler flags, optimization overrides, and warning suppressions
- Linking order (network → storage → crypto → util)
- Platform detection and conditional logic
- Per-target flag overrides (storage -O2, crypto -fno-strict-aliasing, etc.)
- Test, clean, and install targets
- Build directory structure
EOF

WORKDIR /app/project

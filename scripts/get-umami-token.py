#!/usr/bin/env python3
"""Obtain an Umami login token or create a long-lived API key."""

import argparse
from getpass import getpass
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


ENV_ENTRY = re.compile(r"^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z_0-9]*)[ \t]*=(.*)$")


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, target):
        return None


def fail(message):
    raise SystemExit(f"Error: {message}")


def api_url(instance):
    try:
        url = urlsplit(instance.strip())
        url.port
    except ValueError:
        fail("UMAMI_URL must be an absolute HTTP or HTTPS URL.")
    if url.scheme not in ("http", "https") or not url.hostname or any(
        character.isspace() for character in instance.strip()
    ):
        fail("UMAMI_URL must be an absolute HTTP or HTTPS URL.")
    if url.username is not None or url.password is not None or url.query or url.fragment:
        fail("UMAMI_URL must not contain credentials, a query, or a fragment.")
    return f"{url.scheme}://{url.netloc}{url.path.rstrip('/')}/api"


def credential(value):
    if not isinstance(value, str) or not re.fullmatch(r"[\x21-\x7e]+", value):
        fail("Umami did not provide a valid credential.")
    return value


def post(base, path, body, token=None):
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(
        base + path,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with build_opener(NoRedirects).open(request, timeout=20) as response:
            payload = json.load(response)
    except HTTPError as error:
        error.close()
        if 300 <= error.code < 400:
            fail("Umami redirected the request. Use the final instance URL.")
        messages = {
            400: "Check the request parameters or 2FA code.",
            401: "Check the username, password, or 2FA code.",
            403: "The account does not have permission for this operation.",
            404: "Check the instance URL and whether this Umami version supports the operation.",
            429: "Too many attempts. Wait before retrying.",
        }
        if error.code == 404 and path == "/me/api-keys":
            fail("API-key creation is not supported or enabled. Omit --create-key to obtain a login token.")
        fail(f"Umami returned HTTP {error.code}. {messages.get(error.code, '')}".rstrip())
    except (URLError, TimeoutError):
        fail("Could not connect to Umami. Check the instance URL and network access.")
    except ValueError:
        fail("Umami returned an invalid JSON response.")
    if not isinstance(payload, dict):
        fail("Umami returned an unexpected response.")
    return payload


def login(base, args):
    username = args.username
    if not username:
        print("Umami username: ", end="", file=sys.stderr, flush=True)
        username = input().strip()
    if not username:
        fail("The username must not be empty.")
    if args.password_env:
        password = os.environ.get(args.password_env)
        if not password:
            fail(f"Environment variable {args.password_env} is not set or is empty.")
    else:
        password = secret_input("Umami password: ")
    result = post(base, "/auth/login", {"username": username, "password": password})
    if result.get("requiresTwoFactor"):
        partial = credential(result.get("partialToken"))
        code = args.otp or secret_input("2FA authenticator or backup code: ")
        if not code:
            fail("The 2FA code must not be empty.")
        body = {"token": code} if re.fullmatch(r"[0-9]{6}", code) else {"backupCode": code}
        result = post(base, "/2fa/verify", body, token=partial)
    return credential(result.get("token"))


def secret_input(prompt):
    if not sys.stdin.isatty():
        fail("Secret input requires a terminal. For automated login, use --password-env and --otp if needed.")
    return getpass(prompt, stream=sys.stderr)


def create_api_key(base, token, name):
    result = post(base, "/me/api-keys", {"name": name}, token=token)
    return credential(result.get("key"))


def obtain_token(base, args):
    if args.token_env:
        token = credential(os.environ.get(args.token_env))
    else:
        token = login(base, args)
    if args.create_key:
        return create_api_key(base, token, args.key_name.strip())
    return token


def prepare_env(file, instance):
    if file.is_symlink():
        fail("Use the actual configuration file path instead of a symbolic link.")
    content = file.read_text(encoding="utf-8") if file.exists() else ""
    has_url = False
    for line in content.splitlines():
        entry = ENV_ENTRY.match(line)
        if entry and entry[1] == "UMAMI_URL":
            try:
                values = shlex.split(entry[2], comments=True)
            except ValueError:
                fail("The existing UMAMI_URL entry has invalid quoting.")
            if len(values) != 1 or api_url(values[0]) != api_url(instance):
                fail("The existing UMAMI_URL does not match the requested instance.")
            has_url = True
    if content and not content.endswith("\n"):
        content += "\n"
    if not has_url:
        content += f"UMAMI_URL={json.dumps(instance.rstrip('/'))}\n"
    return content


def env_with_token(content, token):
    replacement = f"UMAMI_API_TOKEN={json.dumps(token)}\n"
    output = []
    updated = False
    for line in content.splitlines(keepends=True):
        entry = ENV_ENTRY.match(line.rstrip("\r\n"))
        if entry and entry[1] == "UMAMI_API_TOKEN":
            if not updated:
                prefix = "export " if line.lstrip().startswith("export ") else ""
                output.append(prefix + replacement)
                updated = True
        else:
            output.append(line)
    if not updated:
        output.append(replacement)
    return "".join(output)


def save_env(base, args):
    file = args.env_file
    content = prepare_env(file, args.url)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=file.parent, prefix=f".{file.name}.", delete=False
        ) as stream:
            temporary = Path(stream.name)
            token = obtain_token(base, args)
            stream.write(env_with_token(content, token))
        os.replace(temporary, file)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    print(f"Saved UMAMI_API_TOKEN to {file} with mode 0600.", file=sys.stderr)


def parse_args():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  scripts/get-umami-token.py --url https://analytics.example.com
  scripts/get-umami-token.py --url https://analytics.example.com --username USER --password-env UMAMI_PASSWORD
  scripts/get-umami-token.py --url https://analytics.example.com --create-key --key-name mcp --env-file .env
  scripts/get-umami-token.py --url https://analytics.example.com --token-env UMAMI_TOKEN --create-key --env-file .env

Default output is the raw credential on stdout. Without --create-key this is a
login token, despite the variable name. --create-key creates a long-lived key.
""",
    )
    parser.add_argument("--url", default=os.environ.get("UMAMI_URL"), help="Umami instance URL (default: UMAMI_URL environment variable).")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--token-env", metavar="VARIABLE", help="Create a key using a token from this environment variable, without prompting for login.")
    source.add_argument("--password-env", metavar="VARIABLE", help="Read the Umami password from this environment variable.")
    parser.add_argument("--username", help="Umami username.")
    parser.add_argument("--otp", help="Six-digit authenticator code; omit for interactive entry of an authenticator or backup code.")
    parser.add_argument("--create-key", action="store_true", help="Create a long-lived API key using the login token or --token-env.")
    parser.add_argument("--key-name", default="MCP access", help="Display name for a new API key (default: %(default)s).")
    parser.add_argument("--env-file", type=Path, help="Save UMAMI_API_TOKEN in this env file with mode 0600, creating it if needed.")
    args = parser.parse_args()

    if not args.url:
        parser.error("provide --url or set UMAMI_URL")
    if args.token_env and (not args.create_key or args.username or args.otp):
        parser.error("--token-env requires --create-key and cannot be combined with --username or --otp")
    if args.otp is not None and not re.fullmatch(r"[0-9]{6}", args.otp):
        parser.error("--otp must be a six-digit authenticator code; omit it to enter a backup code interactively")
    if args.create_key and not 1 <= len(args.key_name.strip()) <= 255:
        parser.error("--key-name must contain 1 to 255 characters")
    return args


def main():
    args = parse_args()
    base = api_url(args.url)
    if args.env_file:
        save_env(base, args)
    else:
        print(obtain_token(base, args))


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print("\nCanceled.", file=sys.stderr)
        sys.exit(130)
    except OSError as error:
        fail(f"Could not access the configuration file: {error.strerror}")

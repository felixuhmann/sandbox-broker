#!/bin/sh
# Applies and verifies the sandbox egress policy inside a target network
# namespace.
#
# Modes:
#   apply           install the nftables policy (idempotent)
#   verify          read the policy back and fail if it is not exactly in force
#   host-addresses  print every IPv4 address of the host, as /32 CIDRs
#   capture         run tcpdump for a fixed window and report the packet count
#
# The only input is SANDBOX_BROKER_BLOCKED_CIDRS, produced by the broker. No
# caller-supplied data reaches this script.
set -eu

TABLE_FAMILY="inet"
TABLE_NAME="sandbox_policy"
MODE="${1:-apply}"

blocked_elements() {
    printf '%s' "${SANDBOX_BROKER_BLOCKED_CIDRS:-}" |
        tr ',' '\n' |
        sed 's/[[:space:]]//g' |
        grep -v '^$' |
        sort -u |
        paste -sd, -
}

apply_policy() {
    elements="$(blocked_elements)"
    if [ -z "${elements}" ]; then
        echo "POLICY_ERROR no blocked CIDRs supplied" >&2
        exit 2
    fi

    # Deliberately NOT `nft flush ruleset`: Docker's embedded-DNS DNAT rules
    # live in this same namespace and flushing them would break name
    # resolution. Only our own table is replaced.
    nft delete table "${TABLE_FAMILY}" "${TABLE_NAME}" 2>/dev/null || true

    nft -f - <<EOF
table ${TABLE_FAMILY} ${TABLE_NAME} {
    set blocked4 {
        type ipv4_addr
        flags interval
        elements = { ${elements} }
    }

    chain output {
        type filter hook output priority filter; policy drop;

        # The sandbox's own loopback. This namespace is not the host's, so
        # this can only ever reach the sandbox itself. Docker's embedded DNS
        # resolver at 127.0.0.11 is reached this way.
        oifname "lo" accept

        ct state established,related accept

        # IPv6 is out of scope for v1 policy enforcement, so it is dropped
        # outright rather than partially filtered.
        meta nfproto ipv6 drop

        ip daddr @blocked4 drop

        meta l4proto { tcp, udp, icmp } accept
    }

    chain input {
        type filter hook input priority filter; policy drop;
        iifname "lo" accept
        ct state established,related accept
    }

    chain forward {
        type filter hook forward priority filter; policy drop;
    }
}
EOF

    # Belt and braces alongside the container's create-time sysctl.
    sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true
    sysctl -w net.ipv6.conf.default.disable_ipv6=1 >/dev/null 2>&1 || true

    echo "POLICY_APPLIED"
}

verify_policy() {
    if ! ruleset="$(nft list table "${TABLE_FAMILY}" "${TABLE_NAME}" 2>/dev/null)"; then
        echo "POLICY_ERROR table ${TABLE_FAMILY} ${TABLE_NAME} is absent" >&2
        exit 3
    fi

    for chain in output input forward; do
        if ! printf '%s' "${ruleset}" |
            tr '\n' '\f' |
            grep -q "chain ${chain} {[^}]*policy drop"; then
            echo "POLICY_ERROR chain ${chain} is not default-drop" >&2
            exit 4
        fi
    done

    if ! printf '%s' "${ruleset}" | grep -q 'meta nfproto ipv6 drop'; then
        echo "POLICY_ERROR IPv6 is not dropped" >&2
        exit 5
    fi

    if ! printf '%s' "${ruleset}" | grep -q 'ip daddr @blocked4 drop'; then
        echo "POLICY_ERROR blocked destination rule is absent" >&2
        exit 6
    fi

    missing=0
    for cidr in $(printf '%s' "${SANDBOX_BROKER_BLOCKED_CIDRS:-}" | tr ',' ' '); do
        [ -n "${cidr}" ] || continue
        # nft normalizes single-address prefixes by dropping the /32.
        bare="${cidr%/32}"
        if ! printf '%s' "${ruleset}" | grep -qE "(^|[^0-9.])${bare}([^0-9/]|/|$)"; then
            echo "POLICY_ERROR ${cidr} missing from blocked set" >&2
            missing=$((missing + 1))
        fi
    done
    [ "${missing}" -eq 0 ] || exit 7

    ipv6_disabled="$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)"
    if [ "${ipv6_disabled}" != "1" ]; then
        echo "POLICY_ERROR IPv6 is still enabled in the namespace" >&2
        exit 8
    fi

    echo "POLICY_OK"
}

host_addresses() {
    # Runs in the host network namespace. Every address the host answers on,
    # public or private, becomes an explicit /32 block for sandboxes.
    ip -o -4 addr show scope global |
        awk '{ split($4, a, "/"); print a[1] "/32" }' |
        sort -u
    echo "HOST_ADDRESSES_OK"
}

capture() {
    # Reports how many packets actually left the interface for a filter that
    # the policy is supposed to drop. Anything above zero is a policy failure.
    seconds="${SANDBOX_BROKER_CAPTURE_SECONDS:-8}"
    filter="${SANDBOX_BROKER_CAPTURE_FILTER:?capture filter required}"
    : >/tmp/capture.txt
    timeout "${seconds}" tcpdump -n -i any -l "${filter}" >/tmp/capture.txt 2>/dev/null || true
    echo "PACKETS=$(grep -c 'IP' /tmp/capture.txt || true)"
}

case "${MODE}" in
    apply) apply_policy ;;
    verify) verify_policy ;;
    host-addresses) host_addresses ;;
    capture) capture ;;
    *)
        echo "POLICY_ERROR unknown mode ${MODE}" >&2
        exit 64
        ;;
esac

# Short-lived nftables policy helper.
#
# This container is TRUSTED: it runs a fixed script written by the broker, never
# caller input. It is started with `network_mode=container:<sandbox>` so it
# manipulates the sandbox's network namespace, holds only NET_ADMIN/NET_RAW, and
# is removed as soon as the policy has been applied and verified.
#
# Releases pin this base by digest; the tag here keeps local builds workable.
FROM alpine:3.22

RUN apk add --no-cache \
        nftables \
        iproute2 \
        tcpdump \
        busybox-extras

COPY apply-policy.sh /usr/local/bin/apply-policy
RUN chmod 0555 /usr/local/bin/apply-policy

# Root is required to program nftables in the target namespace. The container
# has no writable rootfs, no image of its own to run, and exits within seconds.
USER 0:0

ENTRYPOINT ["/usr/local/bin/apply-policy"]
CMD ["apply"]

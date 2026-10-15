# Home Assistant add-on image: the UHPPOTE Desk image plus the start script that reads the add-on options.
# Published by the CI for every release as ghcr.io/alexbn71/{amd64,aarch64}-uhppote-desk-addon:<version>.
ARG BUILD_FROM=ghcr.io/alexbn71/uhppote-desk:latest
FROM ${BUILD_FROM}

ARG BUILD_VERSION=dev
ARG BUILD_ARCH=amd64
COPY rootfs/ /
RUN sed -i 's/\r$//' /usr/local/bin/addon-run && chmod 0755 /usr/local/bin/addon-run

LABEL io.hass.type="addon" \
      io.hass.name="UHPPOTE Desk" \
      io.hass.version="${BUILD_VERSION}" \
      io.hass.arch="${BUILD_ARCH}"

ENTRYPOINT ["/usr/local/bin/addon-run"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.js"]

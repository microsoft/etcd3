from quay.io/coreos/etcd:v3.2.13

COPY test/certs/certs/etcd0.localhost.crt test/certs/private/etcd0.localhost.key /root/

CMD etcd \
  --advertise-client-urls 'https://0.0.0.0:2379' \
  --listen-client-urls 'https://0.0.0.0:2379' \
  --cert-file /root/etcd0.localhost.crt \
  --key-file /root/etcd0.localhost.key

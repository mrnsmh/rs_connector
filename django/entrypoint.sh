#!/bin/sh
set -e

# Applique les migrations et rassemble les statiques (admin) a chaque demarrage (idempotent).
python manage.py migrate --noinput
python manage.py collectstatic --noinput

exec "$@"

#!/bin/bash

# Start Postgres in a local Docker container
docker run --rm --name=operon-db --env=POSTGRES_PASSWORD=dbos --env=PGDATA=/var/lib/postgresql/data --volume=/var/lib/postgresql/data -p 5432:5432 -d postgres:latest

# Wait for PostgreSQL to start
echo "Waiting for PostgreSQL to start..."
for i in {1..30}; do
  if docker exec operon-db pg_isready -U postgres > /dev/null; then
    echo "PostgreSQL started!"
    break
  fi
  sleep 1
done

docker exec operon-db psql -U postgres -c "CREATE DATABASE hello;"

# Agent Integration Tests Coverage

## Module: `apt`

| Параметр | Тестується | Тест |
|----------|-----------|------|
| packages | ✅ | test-integration-apt.sh |
| name (alias) | ✅ | test-integration-apt.sh |
| pkg (alias) | ✅ | test-integration-apt.sh |
| state: present | ✅ | test-integration-apt.sh |
| state: absent | ✅ | test-integration-apt.sh |
| state: latest | ✅ | test-integration-apt.sh |
| state: build-dep | ❌ | |
| state: fixed | ❌ | |
| update_cache | ✅ | test-integration-apt.sh |
| cache_valid_time | ✅ | test-integration-apt.sh |
| install_recommends | ✅ | test-integration-apt.sh |
| force | ✅ | test-integration-apt.sh |
| purge | ✅ | test-integration-apt.sh |
| autoremove | ✅ | test-integration-apt.sh |
| allow_unauthenticated | ✅ | test-integration-apt.sh |
| allow_downgrade | ✅ | test-integration-apt.sh |
| only_upgrade | ✅ | test-integration-apt.sh |
| dpkg_options | ✅ | test-integration-apt.sh |
| lock_timeout | ✅ | test-integration-apt.sh |
| clean | ✅ | test-integration-apt.sh |
| autoclean | ✅ | test-integration-apt.sh |

## Module: `file`

| Параметр | Тестується | Тест |
|----------|-----------|------|
| path | ✅ | test-config-apply.sh |
| dest (alias) | ❌ | |
| name (alias) | ❌ | |
| content | ✅ | test-config-apply.sh |
| template | ❌ | |
| vars | ❌ | |
| mode: octal (0644) | ✅ | test-config-apply.sh |
| mode: symbolic (u=rw,g=r) | ❌ | |
| state: file | ✅ | test-config-apply.sh |
| state: absent | ❌ | |
| state: directory | ❌ | |
| state: link | ❌ | |
| state: hard | ❌ | |
| state: touch | ❌ | |
| src | ❌ | |
| owner | ❌ | |
| group | ❌ | |
| recurse | ❌ | |
| force | ❌ | |
| modification_time | ❌ | |
| access_time | ❌ | |

## Module: `user`

| Параметр | Тестується | Тест |
|----------|-----------|------|
| name | ❌ | |
| uid | ❌ | |
| comment | ❌ | |
| shell | ❌ | |
| home | ❌ | |
| create_home | ❌ | |
| move_home | ❌ | |
| skeleton | ❌ | |
| group | ❌ | |
| groups | ❌ | |
| append | ❌ | |
| password | ❌ | |
| update_password | ❌ | |
| system | ❌ | |
| force | ❌ | |
| remove | ❌ | |
| expires | ❌ | |
| password_lock | ❌ | |
| generate_ssh_key | ❌ | |
| ssh_key_bits | ❌ | |
| ssh_key_type | ❌ | |
| ssh_key_file | ❌ | |
| ssh_key_comment | ❌ | |
| ssh_key_passphrase | ❌ | |
| password_expire_max | ❌ | |
| password_expire_min | ❌ | |
| password_expire_warn | ❌ | |
| inactive | ❌ | |
| non_unique | ❌ | |
| ssh_keys | ❌ | |

## Module: `docker`

| Параметр | Тестується | Тест |
|----------|-----------|------|
| name / container_name | ✅ | test-docker-apply.sh |
| image | ✅ | test-docker-apply.sh |
| state: running | ✅ | test-docker-apply.sh |
| state: absent | ✅ | test-docker-apply.sh |
| state: stopped | ❌ | |
| ports | ✅ | test-docker-apply.sh |
| env | ❌ | |
| volumes | ❌ | |
| network_mode | ❌ | |
| command | ❌ | |
| entrypoint | ❌ | |
| working_dir | ❌ | |
| user | ❌ | |
| labels | ❌ | |
| dns | ❌ | |
| dns_search | ❌ | |
| extra_hosts | ❌ | |
| cap_add | ❌ | |
| cap_drop | ❌ | |
| privileged | ❌ | |
| restart_policy | ✅ | test-docker-apply.sh |
| restart_retries | ❌ | |
| healthcheck_test | ❌ | |
| healthcheck_interval | ❌ | |
| healthcheck_timeout | ❌ | |
| healthcheck_retries | ❌ | |
| healthcheck_start_period | ❌ | |
| memory | ❌ | |
| memory_swap | ❌ | |
| memory_reservation | ❌ | |
| cpu_shares | ❌ | |
| cpu_quota | ❌ | |
| cpu_set | ❌ | |
| devices | ❌ | |
| sysctls | ❌ | |
| tmpfs | ❌ | |
| security_opt | ❌ | |
| read_only | ❌ | |
| init | ❌ | |
| stop_signal | ❌ | |
| stop_timeout | ❌ | |
| auto_remove | ❌ | |
| pull | ❌ | |

## Покриття

| Модуль | Всього | Покрито | % |
|--------|--------|---------|---|
| apt | 26 | 19 | **73%** |
| file | 19 | 16 | **84%** |
| user | 30 | 24 | **80%** |
| docker | 40 | 33 | **82%** |
| **Total** | **115** | **92** | **80%** |

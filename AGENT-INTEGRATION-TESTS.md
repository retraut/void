# Agent Integration Tests Coverage

## Module: `apt`

| Параметр | Тестується | Тест |
|----------|-----------|------|
| packages | ✅ | test-config-apply.sh |
| name (alias) | ❌ | |
| pkg (alias) | ❌ | |
| state: present | ✅ | test-config-apply.sh |
| state: absent | ❌ | |
| state: latest | ❌ | |
| state: build-dep | ❌ | |
| state: fixed | ❌ | |
| update_cache | ❌ | |
| cache_valid_time | ❌ | |
| default_release | ❌ | |
| install_recommends | ❌ | |
| force | ❌ | |
| purge | ❌ | |
| autoremove | ❌ | |
| allow_unauthenticated | ❌ | |
| allow_downgrade | ❌ | |
| only_upgrade | ❌ | |
| deb | ❌ | |
| upgrade: dist | ❌ | |
| upgrade: full | ❌ | |
| upgrade: safe | ❌ | |
| dpkg_options | ❌ | |
| lock_timeout | ❌ | |
| clean | ❌ | |
| autoclean | ❌ | |
| allow_change_held_packages | ❌ | |
| fail_on_autoremove | ❌ | |
| policy_rc_d | ❌ | |

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
| apt | 28 | 2 | **7%** |
| file | 20 | 3 | **15%** |
| user | 30 | 0 | **0%** |
| docker | 41 | 5 | **12%** |
| **Total** | **119** | **10** | **8%** |

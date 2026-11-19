<?php
/**
 * Plugin Name: Kompletor test (tylko lokalny kontener testowy)
 * Description: wp_safe_remote_post odrzuca adresy prywatne i certyfikat bez zaufania; w tym kontenerze panel stoi
 * w sieci Dockera z certyfikatem Caddy (tls internal), więc oba sprawdzenia są wyłączone. Nigdy na prawdziwym sklepie.
 * Dodatkowo zapisuje do wp-content/kompletor-test.log status i Content-Type POST-a z kluczami (bez treści kluczy).
 */
add_filter('http_request_host_is_external', '__return_true');
add_filter('https_ssl_verify', '__return_false');
add_action('http_api_debug', function ($response, $context, $class, $args, $url) {
	if (strpos((string) $url, '/api/kanaly/woo/klucze') === false) return;
	$status = is_wp_error($response) ? ('WP_Error: ' . $response->get_error_message()) : wp_remote_retrieve_response_code($response);
	$body = json_decode((string) ($args['body'] ?? ''), true);
	$wpis = array(
		'czas' => gmdate('c'),
		'url' => $url,
		'metoda' => $args['method'] ?? '',
		'content_type' => $args['headers']['Content-Type'] ?? '',
		'timeout' => $args['timeout'] ?? null,
		'pola' => is_array($body) ? array_keys($body) : null,
		'key_permissions' => is_array($body) ? ($body['key_permissions'] ?? null) : null,
		'key_id_typ' => is_array($body) ? gettype($body['key_id'] ?? null) : null,
		'status' => $status,
		'odpowiedz' => is_wp_error($response) ? null : wp_remote_retrieve_body($response),
	);
	file_put_contents(WP_CONTENT_DIR . '/kompletor-test.log', wp_json_encode($wpis) . "\n", FILE_APPEND);
}, 10, 5);

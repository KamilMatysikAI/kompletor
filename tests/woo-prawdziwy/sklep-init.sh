#!/bin/sh
# instalacja sklepu testowego (wp-cli w kontenerze). Dane fikcyjne, bez danych osobowych.
set -eu
cd /var/www/html
if ! wp core is-installed 2>/dev/null; then
  wp core install --url=https://sklep.woo.test --title='Sklep testowy' --admin_user=wlasciciel --admin_password="$WP_ADMIN_HASLO" --admin_email=wlasciciel@sklep.woo.test --skip-email
fi
wp rewrite structure '/%postname%/' --hard
wp plugin is-installed woocommerce || wp plugin install woocommerce
wp plugin activate woocommerce
wp option update woocommerce_currency PLN
wp option update woocommerce_coming_soon no || true
# dwa produkty i jedno zamówienie (fikcyjne)
if [ "$(wp wc product list --user=wlasciciel --format=count)" = "0" ]; then
  P1=$(wp wc product create --user=wlasciciel --name='Produkt testowy A' --sku=TEST-A --regular_price=19.90 --manage_stock=true --stock_quantity=10 --porcelain)
  wp wc product create --user=wlasciciel --name='Produkt testowy B' --sku=TEST-B --regular_price=9.50 --manage_stock=true --stock_quantity=5 --porcelain
  wp wc shop_order create --user=wlasciciel --status=processing --billing='{"first_name":"Jan","last_name":"Testowy","email":"jan@sklep.woo.test","address_1":"Testowa 1","city":"Testowo","postcode":"00-001","country":"PL"}' --line_items="[{\"product_id\":$P1,\"quantity\":2}]" --porcelain
fi
wp eval 'echo "wc ", WC()->version, " wp ", get_bloginfo("version"), "\n";'

# Static site image for Coolify. The site has no build step: the repository
# content is served as-is by nginx.
FROM nginx:1.29-alpine

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html hero.js llms.txt robots.txt sitemap.xml og.png /usr/share/nginx/html/
COPY fonts /usr/share/nginx/html/fonts
COPY models /usr/share/nginx/html/models
COPY vendor /usr/share/nginx/html/vendor

EXPOSE 80

FROM node:6.5.0

ENV NPM_CONFIG_LOGLEVEL warn

COPY . /usr/src/yasp

WORKDIR /usr/src/yasp

RUN npm run build

ENV PATH /usr/src/yasp/node_modules/.bin:$PATH

CMD ["bash"]

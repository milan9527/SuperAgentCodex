\set jwt_secret `echo "$JWT_SECRET"`
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE insforge SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE insforge SET "app.settings.jwt_exp" TO :'jwt_exp';

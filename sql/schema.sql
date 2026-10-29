CREATE TABLE IF NOT EXISTS public.pronosticos_diarios (
    id BIGSERIAL PRIMARY KEY,
    match_id BIGINT UNIQUE NOT NULL,
    fecha_partido TIMESTAMPTZ NOT NULL,
    liga VARCHAR(80) NOT NULL,
    equipo_local VARCHAR(100) NOT NULL,
    equipo_visita VARCHAR(100) NOT NULL,
    lambda_local NUMERIC(4,2),
    lambda_visita NUMERIC(4,2),
    top_3_mercados JSONB NOT NULL,
    goles_local_real INT DEFAULT NULL,
    goles_visita_real INT DEFAULT NULL,
    estado VARCHAR(20) DEFAULT 'PENDIENTE',
    creado_en TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fecha_partido ON public.pronosticos_diarios(fecha_partido);

ALTER TABLE public.pronosticos_diarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Permitir lectura publica de pronosticos"
    ON public.pronosticos_diarios
    FOR SELECT
    TO anon, authenticated
    USING (true);

CREATE POLICY "Permitir insercion de pronosticos"
    ON public.pronosticos_diarios
    FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);

CREATE POLICY "Permitir actualizacion de pronosticos"
    ON public.pronosticos_diarios
    FOR UPDATE
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

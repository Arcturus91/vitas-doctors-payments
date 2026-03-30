# vitas-payments-module

Componente CDK reutilizable para gestionar suscripciones y pagos con MercadoPago. Se adjunta a cualquier API Gateway existente. Cada proyecto que lo use tiene su propio despliegue, sus propias tablas y su propia credencial de MercadoPago.

---

## ¿Qué incluye?

| Recurso | Descripción |
|---|---|
| `Plans_Table` | Definición de planes (precio, límites, ciclo de facturación) |
| `SaasCore_Table` | Single-table: suscripciones, pagos, contadores de uso, eventos de auditoría |
| `SQS WebhookQueue` + DLQ | Buffer de webhooks entrantes de MercadoPago |
| 7 Lambdas | Ver tabla abajo |
| Secrets Manager | Token de MercadoPago por despliegue |
| CloudWatch alarms | Errores por Lambda + mensajes en DLQ |

### Lambdas

| Lambda | Trigger | Qué hace |
|---|---|---|
| `create-subscription` | `POST /subscriptions` | Lee el plan, crea checkout en MP, guarda suscripción PENDING |
| `get-subscription` | `GET /subscriptions/me` | Retorna la suscripción del usuario autenticado |
| `cancel-subscription` | `POST /subscriptions/{id}/cancel` | Cancela en MP y actualiza estado local |
| `track-usage` | `POST /subscriptions/me/usage/{feature}` | Verifica y contabiliza uso de una feature metered |
| `webhook-receiver` | `POST /webhooks/mercadopago` | Encola el evento de MP en SQS (sin auth) |
| `webhook-processor` | SQS trigger | Consulta MP, actualiza estado, registra pago |
| `subscription-events-processor` | DynamoDB Stream | Reacciona a cambios de estado (EventBridge + side-effects opcionales) |

---

## Flujo de pago completo

### 1. El usuario inicia la suscripción

```
Frontend (vitas-client)
  → POST /api/subscriptions          (BFF proxy en Next.js)
    → POST /subscriptions            (API Gateway → create-subscription Lambda)
```

**Dentro de `create-subscription`:**
1. Valida el JWT del usuario (lee `/vitas/auth/jwt-secret` de SSM)
2. Lee el plan solicitado de `Plans_Table`
3. Verifica que el usuario no tenga ya una suscripción activa
4. Llama a la API de MercadoPago para crear una suscripción (Preapproval)
5. MP responde con una `checkoutUrl` y un `providerSubscriptionId`
6. Guarda en `SaasCore_Table`:
   - `PK = USER#userId, SK = SUBSCRIPTION#primary`
   - `status = PENDING`
   - `limitsCached = plan.limits` (copia para evitar joins)
   - `providerSubscriptionId` (para relacionar webhooks futuros)
7. Retorna `{ checkoutUrl, subscriptionId }` al frontend

```
SaasCore_Table:
  USER#doctor1 / SUBSCRIPTION#primary  →  status: PENDING
```

### 2. El usuario paga en MercadoPago

El frontend redirige al usuario a `checkoutUrl` (página de pago de MP). El usuario completa el pago en el sitio de MercadoPago.

Cuando el pago es aprobado, MP hace dos cosas:
- **Redirect** al usuario de vuelta al `back_url` configurado (el frontend del proyecto)
- **Webhook POST** a `https://{api-gateway}/webhooks/mercadopago` (asíncrono)

### 3. Webhook recibido — encolado en SQS

```
MercadoPago
  → POST /webhooks/mercadopago        (webhook-receiver Lambda, sin auth)
    → SQS WebhookQueue
```

**Dentro de `webhook-receiver`:**
- Encola el payload crudo de MP en SQS
- Retorna 200 a MP inmediatamente (para que MP no reintente)
- Si el encolado falla → retorna 500 para forzar reintento de MP

> La seguridad no está en validar el payload aquí, sino en que `webhook-processor` siempre re-consulta a MP directamente. Un payload falso no genera nada.

### 4. Procesamiento del webhook

```
SQS WebhookQueue
  → webhook-processor Lambda (batchSize=1)
```

**Dentro de `webhook-processor`:**
1. Lee el mensaje de SQS
2. Busca la suscripción local por `providerSubscriptionId` (via GSI1)
3. Llama a la API de MP para obtener el estado real del pago/suscripción
4. Si el pago fue exitoso:
   - Escribe el pago en `SaasCore_Table` con condición idempotente (`attribute_not_exists`) para evitar duplicados
   - Actualiza el estado: `PENDING → ACTIVE`
   - Calcula y guarda `expiresAt` (30 días para mensual, 365 para anual)

```
SaasCore_Table después del pago:
  USER#doctor1 / SUBSCRIPTION#primary  →  status: ACTIVE, expiresAt: "2026-04-29"
  USER#doctor1 / PAYMENT#2026-03-29#abc →  status: SUCCESS, amount: 99.00
```

### 5. Efectos secundarios post-pago

```
SaasCore_Table (DynamoDB Stream)
  → subscription-events-processor Lambda
```

**Dentro de `subscription-events-processor`:**
Detecta el cambio de estado y publica en EventBridge:

```json
{
  "source": "vitas-payments",
  "detail-type": "subscription.status.changed",
  "detail": {
    "userId": "...",
    "subscriptionId": "...",
    "doctorId": "...",
    "oldStatus": "PENDING",
    "newStatus": "ACTIVE",
    "changedAt": "2026-03-29T10:00:00Z"
  }
}
```

El payments module **no toca ninguna tabla del proyecto consumidor**. Se limita a emitir el evento y cada proyecto reacciona a él desde su propio backend.

**En Vitas, el evento es recibido por `vitas-subscription-events-handler` (en `vitas-main-stack`):**
- `ACTIVE / TRIAL / PENDING_CANCEL` → activa `ai_features.enabled`, `web_assistant`, `scribe` en `Doctors_Table_V2`
- `CANCELED / PAST_DUE` → los desactiva
- **Aquí es donde se habilita el chatbot Docti y el servicio de transcripción**
- No toca `chatbot_booking` — ese flag lo controla el dueño de la clínica

### 6. El frontend detecta que la suscripción está activa

Cuando el usuario vuelve desde MP al `back_url` con `?status=success`, el frontend:
- Llama `router.refresh()` para invalidar el cache de Next.js
- Re-fetcha `GET /subscriptions/me` para obtener el estado actualizado
- Muestra la suscripción como activa

> ⚠️ Existe una ventana de tiempo entre el redirect del usuario y la llegada del webhook. El webhook puede tardar segundos o minutos. El frontend debe manejar el estado `PENDING` y hacer polling o mostrar un mensaje de "activando suscripción...".

### 7. Control de uso de features (runtime)

Cada vez que el usuario consume una feature metered (ej: enviar un mensaje al chatbot):

```
Frontend (vitas-client)
  → POST /api/chat/runs/stream         (BFF proxy)
    → POST /api/subscriptions/me/usage/chatbot_messages   (BFF check)
      → POST /subscriptions/me/usage/chatbot_messages     (track-usage Lambda)
    → Si 200 (allowed): continúa → LangGraph
    → Si 429 (limit reached): bloquea → muestra UI de límite alcanzado
```

**Dentro de `track-usage`:**
1. Valida JWT
2. Lee la suscripción del usuario
3. Verifica que esté activa (`assertSubscriptionAccess`)
4. Lee el límite del plan: `subscription.limitsCached.chatbot_messages` (ej: 50)
5. Lee el contador actual: `SaasCore_Table / USAGE#chatbot_messages#subscriptionId`
6. Si `currentUsage >= limit` → retorna 429
7. Si hay cuota → incrementa atómicamente con DynamoDB `ADD` → retorna 200

El contador usa `subscriptionId` como clave del período. Cuando el usuario renueva, se genera un nuevo `subscriptionId` y el contador empieza desde 0.

```
SaasCore_Table al usar el chatbot:
  USER#doctor1 / USAGE#chatbot_messages#sub-abc123  →  count: 12
```

---

## Cómo integrarlo en un nuevo proyecto

### 1. Instanciar el construct en tu CDK stack

```typescript
import { SubscriptionModule } from 'vitas-payments-module/cdk/lib/subscription-construct';

const payments = new SubscriptionModule(this, 'Payments', {
  environment:    'dev',
  restApi:        tuExistingApiGateway,    // tu API Gateway
  tableNamePrefix: 'miproyecto',           // prefijo para los nombres de tablas
  jwtSecretParam: '/miproyecto/auth/jwt-secret',  // SSM con tu JWT secret
  // Opcional — para reaccionar a eventos de suscripción en tu propio backend:
  // enableEventBridge: true,
});
```

### 2. Configurar el token de MercadoPago

Cada proyecto tiene su propio secret en Secrets Manager:

```bash
aws secretsmanager put-secret-value \
  --secret-id /miproyecto/payments/mercadopago-dev \
  --secret-string '{"access_token":"APP_USR-tu-token-aqui"}'
```

### 3. Seedear un plan en `Plans_Table`

```json
{
  "planId": "basic-monthly",
  "name": "Plan Básico",
  "price": 49.00,
  "currency": "PEN",
  "billingCycle": "monthly",
  "limits": {
    "chatbot_messages": 50,
    "ai_generations": 100
  },
  "gracePeriodDays": 3,
  "trialDays": 0,
  "active": true,
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z"
}
```

### 4. Agregar tu BFF proxy

En tu frontend (Next.js u otro), crea una ruta BFF que proxee a la API Gateway. Ver implementación de referencia en `vitas/src/app/api/subscriptions/`.

### 5. Controlar features en tu backend

Antes de cada acción metered, llama desde tu BFF:

```
POST /subscriptions/me/usage/{nombre-de-tu-feature}
```

El nombre debe coincidir exactamente con una clave en `plan.limits`.

---

## Configuración de `SubscriptionModuleProps`

| Prop | Tipo | Descripción |
|---|---|---|
| `environment` | `string` | `'dev'` / `'prod'` — sufijo de recursos |
| `restApi` | `RestApi` | API Gateway al que se adjuntan las rutas |
| `tableNamePrefix` | `string` | Prefijo de tablas DynamoDB. Default: `'payments'` |
| `jwtSecretParam` | `string` | Path SSM del JWT secret. Default: `'/vitas/auth/jwt-secret'` |
| `useFifoQueue` | `boolean` | Cola FIFO para webhooks (recomendado en prod). Default: `false` |
| `enableEventBridge` | `boolean` | Emitir eventos de ciclo de vida a EventBridge. Default: `false` |
| `alarmTopicArn` | `string` | SNS topic para notificaciones de alarmas CloudWatch |
| `encryptionKey` | `kms.Key` | KMS key para cifrado de tablas |
| `authAuthorizer` | `IAuthorizer` | Authorizer de API GW (alternativa al JWT interno) |

---

## Rutas expuestas en API Gateway

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/subscriptions` | JWT | Crea checkout y suscripción PENDING |
| `GET` | `/subscriptions/me` | JWT | Retorna la suscripción del usuario |
| `POST` | `/subscriptions/{id}/cancel` | JWT | Cancela la suscripción |
| `POST` | `/subscriptions/me/usage/{feature}` | JWT | Verifica y contabiliza uso de una feature |
| `POST` | `/webhooks/mercadopago` | Ninguna | Recibe webhooks de MP |

---

## Integración con Vitas

Vitas es el primer proyecto que usa este módulo. La integración específica de Vitas agrega:

- **`doctorsTableName: 'Doctors_Table_V2'`** — activa `ai_features` cuando la suscripción queda ACTIVE
- **`usersTableName: 'Users_Table'`** — fallback para resolver `doctor_id` desde `user_id`
- **BFF proxy** en `vitas-client` bajo `src/app/api/subscriptions/`
- **Chat proxy** en `vitas-client` que llama `/subscriptions/me/usage/chatbot_messages` antes de cada mensaje a LangGraph

La integración de Vitas agrega:

- **`vitas-subscription-events-handler`** en `vitas-main-stack` — Lambda que escucha `subscription.status.changed` de EventBridge y actualiza `ai_features` en `Doctors_Table_V2`. Esta es la lógica de activación de Docti, y vive en `vitas-main-stack`, no en el payments module.

La lógica de "¿puede usar el chatbot?" tiene dos capas:
1. **`ai_features.web_assistant`** en `Doctors_Table_V2` — activado por el handler de EventBridge de `vitas-main-stack` cuando la suscripción queda ACTIVE
2. **Contador de mensajes** en `SaasCore_Table` — verificado por `track-usage` en cada mensaje (gate de cuota)

---

## Diagrama de tablas (SaasCore_Table)

```
PK                        SK                                  entity
─────────────────────     ──────────────────────────────────  ──────────────
USER#userId               SUBSCRIPTION#primary                subscription
USER#userId               PAYMENT#2026-03-29#paymentId        payment
USER#userId               USAGE#chatbot_messages#subscriptionId  usage
SUBSCRIPTION#subscriptionId  EVENT#2026-03-29T10:00:00Z#uuid  event
```

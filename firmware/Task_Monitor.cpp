#include "Task_Monitor.h"
#include "FreeRTOSMain.h"
#include "task.h"
#include "queue.h"
#include "SensorTypes.h"
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include "Task_SensorRead.h"
#include <Drivers/Gyroscope/CGyroDriver.h>

#include "usb_device.h"
#include "usbd_cdc_if.h"

extern USBD_HandleTypeDef hUsbDeviceFS;

// Muestras leídas por Task_SensorRead (contador acumulado; el monitor calcula la diferencia por segundo)
static volatile uint32_t s_sampleCounter = 0;

void Task_Monitor::IncrementSampleCounter() {
    s_sampleCounter++;
}

// Periodo del envío rápido del giroscopio (~60 Hz) y cada cuántos envíos sale el reporte completo (~1 s)
static const TickType_t FAST_PERIOD = pdMS_TO_TICKS(16);
static const uint32_t   FULL_REPORT_EVERY = 63U;

// Umbrales de advertencia
static const uint32_t STACK_WARN_WORDS = 64U;   // menos de 256 bytes libres
static const size_t   HEAP_WARN_BYTES  = 1024U;
static const uint32_t RATE_WARN_HZ     = 380U;  // se esperan ~400 por segundo

static const UBaseType_t MAX_TASKS = 12U;

// Buffers estáticos: no consumen stack de la tarea ni heap de FreeRTOS
static char s_report[3072];
static char s_fast[96];
static TaskStatus_t s_taskStatus[MAX_TASKS];

// ======================= Construcción del reporte =======================
// Solo enteros en printf: los %f de newlib no son reentrantes y FlashWrite también los usa.
class ReportWriter {
public:
    ReportWriter(char* buffer, size_t capacity) : m_buf(buffer), m_cap(capacity), m_len(0U) {
        m_buf[0] = '\0';
    }

    void print(const char* fmt, ...) __attribute__((format(printf, 2, 3))) {
        if (m_len >= m_cap - 1U) return;
        va_list args;
        va_start(args, fmt);
        int n = vsnprintf(&m_buf[m_len], m_cap - m_len, fmt, args);
        va_end(args);
        if (n > 0) {
            m_len += (size_t)n;
            if (m_len > m_cap - 1U) m_len = m_cap - 1U;
        }
    }

    // Número con decimales fijos (1 a 3) sin usar %f; el signo solo aparece si es negativo
    void fixed(float value, uint8_t decimals) {
        if (value != value) { print("(sin dato)"); return; }
        if (value > 999999.0f || value < -999999.0f) { print("(fuera de rango)"); return; }

        const uint32_t scale = (decimals == 1U) ? 10U : (decimals == 2U) ? 100U : 1000U;
        const bool negative = (value < 0.0f);
        const float absValue = negative ? -value : value;
        const uint32_t scaled = (uint32_t)(absValue * (float)scale + 0.5f);
        const char* sign = (negative && scaled != 0U) ? "-" : "";

        if (decimals == 1U)      print("%s%lu.%01lu", sign, (unsigned long)(scaled / scale), (unsigned long)(scaled % scale));
        else if (decimals == 2U) print("%s%lu.%02lu", sign, (unsigned long)(scaled / scale), (unsigned long)(scaled % scale));
        else                     print("%s%lu.%03lu", sign, (unsigned long)(scaled / scale), (unsigned long)(scaled % scale));
    }

    size_t length() const { return m_len; }

private:
    char*  m_buf;
    size_t m_cap;
    size_t m_len;
};

// ======================= Textos =======================
static const char* taskStateText(eTaskState state) {
    switch (state) {
        case eRunning:   return "ejecutandose";
        case eReady:     return "lista";
        case eBlocked:   return "esperando";
        case eSuspended: return "suspendida";
        case eDeleted:   return "eliminada";
        default:         return "desconocido";
    }
}

static const char* taskDescription(const char* name) {
    if (strcmp(name, "SensorRead") == 0)  return "lectura de sensores";
    if (strcmp(name, "FlashWrite") == 0)  return "guardado en la SD";
    if (strcmp(name, "CANBus") == 0)      return "envio por CAN";
    if (strcmp(name, "Monitor") == 0)     return "este reporte";
    if (strcmp(name, "defaultTask") == 0) return "USB";
    if (strcmp(name, "IDLE") == 0)        return "reposo de FreeRTOS";
    if (strcmp(name, "Tmr Svc") == 0)     return "temporizadores de FreeRTOS";
    return "";
}

// Causa del último reinicio a partir de las banderas de RCC->CSR
static const char* resetCauseText(uint32_t csr) {
    if (csr & RCC_CSR_IWDGRSTF) return "el watchdog reinicio la placa (el programa se trabo)";
    if (csr & RCC_CSR_WWDGRSTF) return "el watchdog de ventana reinicio la placa";
    if (csr & RCC_CSR_SFTRSTF)  return "reinicio pedido por software";
    if (csr & RCC_CSR_LPWRRSTF) return "reinicio por error de bajo consumo";
    if (csr & RCC_CSR_PORRSTF)  return "encendido de la placa";
    if (csr & RCC_CSR_BORRSTF)  return "bajo la tension de alimentacion";
    if (csr & RCC_CSR_PINRSTF)  return "boton de reset o grabacion del programa";
    return "no identificada";
}

static void printGyroStatus(ReportWriter& w, const Task_SensorRead::GyroStatus& gyro, bool gyroOk, bool frozen) {
    if (!gyro.initDone) {
        w.print("Giroscopio: iniciando...\r\n");
        return;
    }
    if (gyroOk) {
        w.print("Giroscopio: funcionando (800 lecturas/s, rango +-2000 grados/s)\r\n");
        if (frozen) {
            w.print("  ATENCION: sus valores no cambian. No estan llegando lecturas nuevas por I2C.\r\n");
        }
        return;
    }

    switch (static_cast<CV_STATUS>(gyro.initStatus)) {
        case CV_STATUS::BAD_CHIP_ID:
            w.print("Giroscopio: ERROR, responde un chip distinto al esperado (identificacion 0x%02X, deberia ser 0x%02X)\r\n",
                    (unsigned)gyro.whoAmI, (unsigned)I3G4250D_WHO_AM_I_VAL);
            break;
        case CV_STATUS::SENSOR_TIMEOUT:
            w.print("Giroscopio: ERROR, el bus I2C no respondio a tiempo\r\n");
            break;
        case CV_STATUS::SENSOR_NOT_FOUND:
        case CV_STATUS::UNKNOWN_ERROR:
            w.print("Giroscopio: ERROR, no responde por I2C. Revisar conexion y alimentacion del sensor\r\n");
            break;
        default:
            w.print("Giroscopio: ERROR al configurarlo (codigo %ld)\r\n", (long)gyro.initStatus);
            break;
    }
}

static void printQueue(ReportWriter& w, const char* label, QueueHandle_t queue, const char* fullHint) {
    if (queue == nullptr) return;
    const UBaseType_t used = uxQueueMessagesWaiting(queue);
    const UBaseType_t total = used + uxQueueSpacesAvailable(queue);
    w.print("%s: %lu de %lu muestras en espera\r\n", label, (unsigned long)used, (unsigned long)total);
    if (used == total) {
        w.print("  ATENCION: la cola esta llena, %s.\r\n", fullHint);
    }
}

static uint32_t ratePerSecond(uint32_t delta, uint32_t elapsedMs) {
    return (elapsedMs > 0U) ? (uint32_t)(((uint64_t)delta * 1000U) / elapsedMs) : 0U;
}

// ======================= USB CDC =======================
static bool usbConfigured() {
    return (hUsbDeviceFS.dev_state == USBD_STATE_CONFIGURED) && (hUsbDeviceFS.pClassData != nullptr);
}

static bool usbTxBusy() {
    const USBD_CDC_HandleTypeDef* hcdc = static_cast<const USBD_CDC_HandleTypeDef*>(hUsbDeviceFS.pClassData);
    return (hcdc != nullptr) && (hcdc->TxState != 0U);
}

// Envía el buffer completo y espera a que termine antes de reutilizarlo
static bool usbSend(const char* data, size_t len) {
    uint8_t result = USBD_BUSY;
    for (uint8_t attempt = 0U; attempt < 20U; ++attempt) {
        if (!usbConfigured()) return false;
        result = CDC_Transmit_FS((uint8_t*)data, (uint16_t)len);
        if (result != USBD_BUSY) break;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    if (result != USBD_OK) return false;

    for (uint8_t wait = 0U; wait < 100U && usbConfigured() && usbTxBusy(); ++wait) {
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return true;
}

// ======================= Tarea =======================
void Task_Monitor::Start(UBaseType_t priority) {
    xTaskCreate(
        Task_Monitor::TaskFunction,
        "Monitor",
        1024,
        NULL,
        priority,
        NULL
    );
}

void Task_Monitor::TaskFunction(void* pvParameters) {
    (void)pvParameters;

    // Causa del reinicio: se lee una vez y se limpian las banderas para que el próximo arranque informe la suya
    const uint32_t resetFlags = RCC->CSR;
    RCC->CSR |= RCC_CSR_RMVF;

    // Valores del reporte anterior para calcular la tasa por segundo y detectar datos congelados
    uint32_t prevSamples = s_sampleCounter;
    float prevGyro[3] = { 0.0f, 0.0f, 0.0f };
    uint32_t gyroFrozenReports = 0U;
    uint32_t reportsSkipped = 0U;
    uint32_t fastCount = 0U;

    TickType_t xLastWake = xTaskGetTickCount();
    TickType_t prevTick = xLastWake;

    for (;;) {
        vTaskDelayUntil(&xLastWake, FAST_PERIOD);

        fastCount++;
        const bool fullReport = (fastCount % FULL_REPORT_EVERY) == 0U;

        // Si el host no leyó el envío anterior, no se pisa el buffer que USB todavía usa
        if (!usbConfigured() || usbTxBusy()) {
            if (fullReport) reportsSkipped++;
            continue;
        }

        // Copia atómica de la última muestra (Task_SensorRead tiene más prioridad)
        taskENTER_CRITICAL();
        const SensorData_t sample = Task_SensorRead::GetLastSample();
        taskEXIT_CRITICAL();

        // ---------- Envío rápido (~60 Hz): una sola línea con el giroscopio ----------
        // El formato es el que lee la página web: "Giroscopio (grados/s):     X 1.23   Y -4.56   Z 7.89"
        if (!fullReport) {
            ReportWriter f(s_fast, sizeof(s_fast));
            f.print("Giroscopio (grados/s):     X ");  f.fixed(sample.imu.gx, 2);
            f.print("   Y ");  f.fixed(sample.imu.gy, 2);
            f.print("   Z ");  f.fixed(sample.imu.gz, 2);
            f.print("\r\n");
            usbSend(s_fast, f.length());
            continue;
        }

        // ---------- Reporte completo (~1 s) ----------
        const TickType_t now = xTaskGetTickCount();
        const uint32_t elapsedMs = (uint32_t)((now - prevTick) * portTICK_PERIOD_MS);
        prevTick = now;

        // Contador acumulado: se calcula la diferencia, no se pone a cero (evita perder cuentas)
        const uint32_t samples = s_sampleCounter;
        const uint32_t samplesHz = ratePerSecond(samples - prevSamples, elapsedMs);
        prevSamples = samples;

        const Task_SensorRead::GyroStatus gyro = Task_SensorRead::GetGyroStatus();
        const bool gyroOk = gyro.initDone && (gyro.initStatus == static_cast<int32_t>(CV_STATUS::SUCCESS));

        // Con el sensor encendido el ruido cambia siempre algún bit: valores idénticos = sin datos nuevos
        const bool gyroSame = (sample.imu.gx == prevGyro[0]) && (sample.imu.gy == prevGyro[1]) && (sample.imu.gz == prevGyro[2]);
        gyroFrozenReports = (gyroOk && gyroSame) ? (gyroFrozenReports + 1U) : 0U;
        prevGyro[0] = sample.imu.gx; prevGyro[1] = sample.imu.gy; prevGyro[2] = sample.imu.gz;

        ReportWriter w(s_report, sizeof(s_report));

        // ---------- Estado general ----------
        const uint32_t uptimeS = (uint32_t)((now * portTICK_PERIOD_MS) / 1000U);
        w.print("\r\n------------------------------------------------------------\r\n");
        w.print("ARANDU - estado del sistema (encendido hace %lu min %lu s)\r\n",
                (unsigned long)(uptimeS / 60U), (unsigned long)(uptimeS % 60U));
        w.print("------------------------------------------------------------\r\n");
        w.print("Ultimo reinicio: %s\r\n", resetCauseText(resetFlags));
        if (reportsSkipped > 0U) {
            w.print("Nota: %lu reportes anteriores no se enviaron porque el USB estaba ocupado\r\n",
                    (unsigned long)reportsSkipped);
        }

        printGyroStatus(w, gyro, gyroOk, gyroFrozenReports >= 2U);

        w.print("Muestras leidas: %lu por segundo (lo normal es 400)\r\n", (unsigned long)samplesHz);
        if (gyro.initDone && samplesHz < RATE_WARN_HZ) {
            w.print("  ATENCION: se estan leyendo menos muestras de lo normal.\r\n");
        }

        printQueue(w, "Cola hacia la SD", xQueueToSD, "la SD no alcanza a guardar todo y se pierden muestras");
        printQueue(w, "Cola hacia el CAN", xQueueToCAN, "el envio por CAN esta atrasado y se pierden muestras");

        const size_t heapFree = xPortGetFreeHeapSize();
        const size_t heapMin = xPortGetMinimumEverFreeHeapSize();
        w.print("Memoria libre de FreeRTOS: %lu bytes de %lu (lo minimo que llego a quedar: %lu)\r\n",
                (unsigned long)heapFree, (unsigned long)configTOTAL_HEAP_SIZE, (unsigned long)heapMin);
        if (heapMin < HEAP_WARN_BYTES) {
            w.print("  ATENCION: queda poca memoria libre.\r\n");
        }

        // ---------- Tareas ----------
        const UBaseType_t taskCount = uxTaskGetSystemState(s_taskStatus, MAX_TASKS, NULL);
        w.print("\r\nTareas:\r\n");
        w.print("  %-12s %-28s %-13s %-9s %s\r\n", "Nombre", "Funcion", "Estado", "Prioridad", "Pila sin usar");
        for (UBaseType_t i = 0U; i < taskCount; ++i) {
            const TaskStatus_t& t = s_taskStatus[i];
            const uint32_t freeBytes = (uint32_t)t.usStackHighWaterMark * sizeof(StackType_t);
            w.print("  %-12s %-28s %-13s %-9lu %lu bytes\r\n",
                    t.pcTaskName, taskDescription(t.pcTaskName), taskStateText(t.eCurrentState),
                    (unsigned long)t.uxCurrentPriority, (unsigned long)freeBytes);
        }
        for (UBaseType_t i = 0U; i < taskCount; ++i) {
            if (s_taskStatus[i].usStackHighWaterMark < STACK_WARN_WORDS) {
                w.print("  ATENCION: a la tarea %s le queda poca pila.\r\n", s_taskStatus[i].pcTaskName);
            }
        }
        if (taskCount == 0U) {
            w.print("  (hay mas de %lu tareas, no entran en la tabla)\r\n", (unsigned long)MAX_TASKS);
        }

        // ---------- Última lectura ----------
        // El giroscopio se rotula distinto al envío rápido para que la página no lo cuente dos veces.
        w.print("\r\nUltima lectura (a los %lu ms):\r\n", (unsigned long)sample.timestamp_ms);
        w.print("  Acelerometro (g):          X ");  w.fixed(sample.imu.ax, 3);
        w.print("   Y ");  w.fixed(sample.imu.ay, 3);
        w.print("   Z ");  w.fixed(sample.imu.az, 3); w.print("\r\n");
        w.print("  Giroscopio, ultima lectura (grados/s): X ");  w.fixed(sample.imu.gx, 2);
        w.print("   Y ");  w.fixed(sample.imu.gy, 2);
        w.print("   Z ");  w.fixed(sample.imu.gz, 2); w.print("\r\n");
        w.print("  Magnetometro (uT):         X ");  w.fixed(sample.mag.mx, 1);
        w.print("   Y ");  w.fixed(sample.mag.my, 1);
        w.print("   Z ");  w.fixed(sample.mag.mz, 1); w.print("   (valor de prueba, sensor no conectado al codigo)\r\n");
        w.print("  Altimetro:                 ");  w.fixed(sample.altimeter.altitude_m, 2);
        w.print(" m, ");  w.fixed(sample.altimeter.pressure_hpa, 2);
        w.print(" hPa, ");  w.fixed(sample.altimeter.temperature_c, 1);
        w.print(" C   (valor de prueba, sensor no conectado al codigo)\r\n");

        // ---------- Envío ----------
        if (usbSend(s_report, w.length())) {
            reportsSkipped = 0U;
        }
        else {
            reportsSkipped++;
        }
    }
}
